"""
Continuous Learning & Semantic RAG retrieval module.
Records user decisions (approvals, edits, cancellations) and retrieves relevant past examples/rules.
Uses cosine similarity over embeddings (or robust keyword/ngram fallback if OpenAI key is not provided).
"""

import math
import json
import os
import re
from typing import List, Dict, Any, Optional
from core.db import get_db_connection, DEFAULT_DB_PATH


def cosine_similarity(v1: List[float], v2: List[float]) -> float:
    """Computes cosine similarity between two float vectors."""
    if not v1 or not v2 or len(v1) != len(v2):
        return 0.0
    dot = sum(a * b for a, b in zip(v1, v2))
    norm1 = math.sqrt(sum(a * a for a in v1))
    norm2 = math.sqrt(sum(b * b for b in v2))
    if norm1 == 0.0 or norm2 == 0.0:
        return 0.0
    return dot / (norm1 * norm2)


def get_embedding(text: str, client: Optional[Any] = None, model: str = "text-embedding-3-small") -> List[float]:
    """
    Computes vector embedding using OpenAI API if client is provided,
    otherwise returns an empty list.
    """
    if not client or not text.strip():
        return []
    try:
        clean_text = text.replace("\n", " ").strip()
        response = client.embeddings.create(input=[clean_text], model=model)
        return response.data[0].embedding
    except Exception as e:
        # Fallback if API fails or rate limited
        return []


def record_feedback(
    contact: str,
    context_summary: str,
    review_action: str,
    original_draft: str = "",
    final_msg: str = "",
    reason_notes: str = "",
    client: Optional[Any] = None,
    embedding_model: str = "text-embedding-3-small",
    source: str = "MANUAL_REVIEW",
    category: str = "",
    decision: str = "",
    rule_ids: Optional[List[str]] = None,
    required_human_action: Optional[str] = None,
    not_before: Optional[str] = None,
    conversation_version: Optional[str] = None,
    original_decision: Optional[str] = None,
    corrected_decision: Optional[str] = None,
    correction_type: Optional[str] = None,
    reviewer_authority: str = "OPERATOR",
    state_snapshot: Optional[str] = None,
    catalogue_version: str = "2.0.0",
    db_path: str = DEFAULT_DB_PATH
) -> int:
    """
    Saves a learning record to feedback_learning table.
    review_action must be one of: 'APPROVED', 'MODIFIED', 'CANCELLED', 'DEFERRED', 'HUMAN_REVIEW'
    """
    vector = get_embedding(context_summary, client=client, model=embedding_model) if client else []
    vector_json = json.dumps(vector) if vector else ""
    rule_ids_json = json.dumps(rule_ids or [])

    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute("""
    INSERT INTO feedback_learning (
        contact, context_summary, embedding_json, original_draft,
        final_msg, review_action, reason_notes, source, category,
        decision, rule_ids, required_human_action, not_before, conversation_version,
        original_decision, corrected_decision, correction_type, reviewer_authority,
        state_snapshot, catalogue_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    """, (
        contact,
        context_summary,
        vector_json,
        original_draft,
        final_msg,
        review_action,
        reason_notes,
        source,
        category,
        decision,
        rule_ids_json,
        required_human_action,
        not_before,
        conversation_version,
        original_decision or decision,
        corrected_decision or decision,
        correction_type or ("wording" if review_action == "MODIFIED" else "none"),
        reviewer_authority,
        state_snapshot,
        catalogue_version
    ))
    record_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return record_id


def retrieve_relevant_rules(
    current_context: str,
    top_k: int = 5,
    client: Optional[Any] = None,
    embedding_model: str = "text-embedding-3-small",
    db_path: str = DEFAULT_DB_PATH
) -> List[Dict[str, Any]]:
    """
    Retrieves the most semantically relevant past decisions and rules for current context.
    Uses vector cosine similarity if embeddings exist, and word overlap / recency fallback.
    Gives prioritized weight to MANUAL_REVIEW over STARTER_BATCH so human reviews take precedence.
    """
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute("""
    SELECT id, contact, context_summary, embedding_json, original_draft,
           final_msg, review_action, reason_notes, source, category, created_at
    FROM feedback_learning
    ORDER BY id DESC
    """)
    rows = cursor.fetchall()
    conn.close()

    if not rows:
        return []

    # If client is provided, get current context embedding
    query_vector = get_embedding(current_context, client=client, model=embedding_model) if client else []

    scored_records = []
    current_tokens = set(re.findall(r"\w+", current_context.lower()))

    for row in rows:
        item = dict(row)
        raw_score = 0.0
        
        # 1. Vector cosine similarity if available
        emb_str = item.get("embedding_json")
        if query_vector and emb_str:
            try:
                emb = json.loads(emb_str)
                if emb:
                    raw_score = cosine_similarity(query_vector, emb)
            except Exception:
                raw_score = 0.0

        # 2. Token overlap fallback / booster
        if raw_score == 0.0 and current_tokens:
            target_tokens = set(re.findall(r"\w+", (item.get("context_summary") or "").lower()))
            if target_tokens:
                overlap = len(current_tokens.intersection(target_tokens))
                raw_score = overlap / max(len(current_tokens), 1)

        # Source priority: manual human reviews get higher priority boost (+0.08)
        # so as new manually reviewed cases are added, they naturally override starter batch examples.
        source = (item.get("source") or "MANUAL_REVIEW").upper()
        final_score = raw_score + (0.08 if source == "MANUAL_REVIEW" else 0.0)

        item["raw_similarity"] = round(raw_score, 4)
        item["similarity_score"] = round(final_score, 4)
        scored_records.append(item)

    # Sort descending by score, then by id
    scored_records.sort(key=lambda x: (x["similarity_score"], x["id"]), reverse=True)
    return scored_records[:top_k]


def format_rules_for_prompt(records: List[Dict[str, Any]]) -> str:
    """Formats retrieved feedback records into clean, authoritative guidance for the LLM."""
    if not records:
        return "No similar historical examples found. Use your best judgment."

    lines = [
        "### DYNAMIC OPERATOR REVIEWS & CORRECTIONS (HIGHEST PRECEDENCE):",
        "The following decisions were made by human operators on real customer chats matching this context.",
        "Treat human corrections and reviewer decisions as authoritative precedence:"
    ]
    for idx, r in enumerate(records, 1):
        action = r.get("review_action")
        notes = r.get("reason_notes") or ""
        summary = r.get("context_summary") or ""
        orig = r.get("original_draft") or ""
        final = r.get("final_msg") or ""
        src = "Operator Review" if (r.get("source") or "").upper() == "MANUAL_REVIEW" else "Real Sent Example"

        if action == "CANCELLED":
            reason_str = f" Directive / Reason: '{notes}'." if notes else ""
            lines.append(f"{idx}. [DO NOT MESSAGE] ({src}) Context: '{summary}'.{reason_str} -> Model must choose 'NO_MESSAGE' / 'SKIP'.")
        elif action == "MODIFIED":
            lines.append(f"{idx}. [CORRECTION] ({src}) Context: '{summary}'. Human operator changed draft from '{orig}' to '{final}'. Correction rationale: '{notes}'. -> Follow this phrasing and decision.")
        elif action == "APPROVED":
            msg = final or orig
            notes_str = f" Note: {notes}" if notes and "directly" not in notes.lower() else ""
            lines.append(f"{idx}. [APPROVED FOLLOW-UP] ({src}) Context: '{summary}'. Sent message: '{msg}'.{notes_str}")
        else:
            lines.append(f"{idx}. [OPERATOR EXAMPLE] Context: '{summary}'. Message: '{final or orig}'.")

    return "\n".join(lines)


def _normalize_tokens(text: str) -> set:
    """Extracts lowercase tokens with light stemming for plurals and verb forms."""
    if not text:
        return set()
    raw = re.findall(r"[a-zA-Z0-9\u0600-\u06ff]+", text.lower())
    tokens = set()
    for w in raw:
        tokens.add(w)
        if len(w) > 3 and w.endswith("s"):
            tokens.add(w[:-1])
        if len(w) > 4 and w.endswith("ing"):
            tokens.add(w[:-3])
        if len(w) > 4 and w.endswith("ed"):
            tokens.add(w[:-2])
    return tokens


def retrieve_canonical_rules(
    current_context: str,
    top_k: int = 6,
    client: Optional[Any] = None,
    embedding_model: str = "text-embedding-3-small",
    db_path: str = DEFAULT_DB_PATH
) -> List[Dict[str, Any]]:
    """
    Retrieves canonical rule cards from canonical_rules table based on hybrid
    retrieval (lexical aliases/keywords + vector cosine similarity).
    """
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute("""
    SELECT id, title, category, decision_pattern, version, evidence_basis,
           required_evidence, reason, exclusions, preferred_messages,
           retrieval_aliases, runtime_note, embedding_text, embedding_json
    FROM canonical_rules
    """)
    rows = cursor.fetchall()
    conn.close()

    if not rows:
        return []

    context_lower = current_context.lower()
    current_tokens = _normalize_tokens(current_context)
    query_vector = get_embedding(current_context, client=client, model=embedding_model) if client else []

    scored_rules = []
    for row in rows:
        item = dict(row)
        score = 0.0

        # 1. Vector similarity if available
        emb_str = item.get("embedding_json")
        if query_vector and emb_str:
            try:
                emb = json.loads(emb_str)
                if emb:
                    score += cosine_similarity(query_vector, emb) * 2.0
            except Exception:
                pass

        # 2. Lexical search across retrieval_aliases
        aliases = []
        try:
            aliases = json.loads(item.get("retrieval_aliases") or "[]")
        except Exception:
            aliases = []

        for alias in aliases:
            a_clean = alias.lower().strip()
            if a_clean and a_clean in context_lower:
                score += 3.0
            a_tokens = _normalize_tokens(a_clean)
            if a_tokens and current_tokens:
                overlap = len(current_tokens.intersection(a_tokens))
                score += (overlap / len(a_tokens)) * 1.5

        # 3. Token overlap with title & required evidence
        title_tokens = _normalize_tokens(item.get("title") or "")
        if title_tokens and current_tokens:
            overlap = len(current_tokens.intersection(title_tokens))
            score += (overlap / len(title_tokens)) * 2.0

        req_str = item.get("required_evidence") or ""
        req_tokens = _normalize_tokens(req_str)
        if req_tokens and current_tokens:
            overlap = len(current_tokens.intersection(req_tokens))
            score += (overlap / len(req_tokens)) * 1.0

        # 4. If category matches context keywords (e.g. sales vs support vs guard)
        cat = (item.get("category") or "").lower()
        if "support" in context_lower and "support" in cat:
            score += 0.5
        elif any(w in context_lower for w in ["price", "cost", "renew", "plan", "offer", "buy", "se3er", "as3ar", "dollars", "$"]) and "sales" in cat:
            score += 0.5

        # 5. Targeted domain & cancellation boosts based on manual fixes db
        rule_id = item.get("id")
        if rule_id == "SUPPORT_06" and any(w in context_lower for w in ["thank", "merci", "thx", "thanks", "done", "ur welcome", "welcomee", "👍", "❤️", "🙏🏻"]):
            score += 5.0
        elif rule_id == "SUPPORT_12" and "anghami" in context_lower:
            score += 4.0
        elif rule_id == "GUARD_04" and any(w in context_lower for w in ["voice message", "🎤", "voice note"]):
            score += 5.0
        elif rule_id == "GUARD_03" and any(w in context_lower for w in ["paid", "w2w", "transfer", "receipt"]):
            score += 4.0
        elif rule_id in ("SALES_10", "SALES_11") and any(w in context_lower for w in ["bredelkon", "breddelkoun", "mish hala2", "not at the moment", "no thanks", "anyway thanks", "shway w bshuf"]):
            score += 4.5
        elif rule_id == "SALES_13" and ("final followup;" in context_lower or "last followup" in context_lower):
            score += 5.0
        elif rule_id == "SALES_04" and any(w in context_lower for w in ["private", "shared", "unlimited", "expensive", "ghale"]):
            score += 3.0

        item["match_score"] = round(score, 4)
        scored_rules.append(item)

    # Sort descending by score, then id
    scored_rules.sort(key=lambda x: (x["match_score"], x["id"]), reverse=True)
    return scored_rules[:top_k]


def format_canonical_rules_for_prompt(records: List[Dict[str, Any]]) -> str:
    """Formats retrieved canonical v2 rule cards for the prompt."""
    if not records:
        return ""

    lines = ["### CANONICAL KNOWLEDGE RULES (feedback_learning_v2):"]
    for r in records:
        rule_id = r.get("id")
        title = r.get("title")
        cat = r.get("category", "").upper()
        pat = r.get("decision_pattern")
        reason = r.get("reason", "")

        req_list = []
        try:
            req_list = json.loads(r.get("required_evidence") or "[]")
        except Exception:
            pass
        req_str = "; ".join(req_list) if req_list else "None"

        excl_list = []
        try:
            excl_list = json.loads(r.get("exclusions") or "[]")
        except Exception:
            pass
        excl_str = "; ".join(excl_list) if excl_list else "None"

        pref = {}
        try:
            pref = json.loads(r.get("preferred_messages") or "{}")
        except Exception:
            pass
        examples = []
        if pref.get("english"):
            examples.append("English: " + " / ".join(pref["english"]))
        if pref.get("lebanese_arabizi"):
            examples.append("Lebanese: " + " / ".join(pref["lebanese_arabizi"]))
        ex_str = " | ".join(examples) if examples else "None"

        pattern_label = pat
        if pat == "SKIP":
            pattern_label = "SKIP -> MANDATORY: NO_MESSAGE"
        elif pat == "ENFORCE_ALWAYS":
            pattern_label = "ENFORCE_ALWAYS -> MANDATORY GUARD"

        lines.append(
            f"[{rule_id}] {title} ({cat} | Pattern: {pattern_label})\n"
            f"  • Requirements: {req_str}\n"
            f"  • Reason: {reason}\n"
            f"  • Exclusions / Near Misses: {excl_str}\n"
            f"  • Preferred Examples: {ex_str}"
        )

    return "\n\n".join(lines)


def teach_skipped_followup(
    contact: str,
    message: str,
    reason_notes: str = "",
    client: Optional[Any] = None,
    embedding_model: str = "text-embedding-3-small",
    queue_for_send: bool = True,
    db_path: str = DEFAULT_DB_PATH
) -> Dict[str, Any]:
    """
    Teaches the system that a contact that was skipped (or missed) should have received a follow-up.
    - Normalizes the phone number.
    - Retrieves conversation history and summarizes context.
    - Updates existing draft (or creates a new draft) with status 'MODIFIED'.
    - Queues the follow-up message into send_queue if queue_for_send is True.
    - Records a high-priority learning record into feedback_learning with semantic embeddings.
    """
    from core.importer import normalize_phone
    from core.analyzer import format_chat_transcript, summarize_transcript
    from core.sender import queue_draft_for_sending

    norm_phone = normalize_phone(contact)
    if not norm_phone:
        norm_phone = contact.strip()

    conn = get_db_connection(db_path)
    cur = conn.cursor()

    # 1. Fetch contact messages history
    cur.execute("""
    SELECT direction, message, timestamp
    FROM chats
    WHERE contact = ?
    ORDER BY timestamp ASC, id ASC
    """, (norm_phone,))
    messages = [dict(r) for r in cur.fetchall()]

    if messages:
        transcript = format_chat_transcript(messages)
        context_summary = summarize_transcript(transcript)
    else:
        # Check if contact exists in contacts table or default
        context_summary = f"Contact {norm_phone} conversation"

    # 2. Check for existing draft
    cur.execute("""
    SELECT id, drafted_msg, reasoning, status, cancel_reason
    FROM followup_drafts
    WHERE contact = ?
    ORDER BY id DESC
    LIMIT 1
    """, (norm_phone,))
    draft_row = cur.fetchone()

    draft_id = None
    orig_draft = ""
    learning_notes = reason_notes.strip() if reason_notes else "User corrected skipped contact: should have received follow-up"

    if draft_row:
        draft_id = draft_row["id"]
        orig_draft = draft_row["drafted_msg"] or ""
        prev_status = draft_row["status"]
        cur.execute("""
        UPDATE followup_drafts
        SET drafted_msg = ?, status = 'MODIFIED', decision = 'SEND', category = 'sales',
            rule_ids = '["SALES_01"]', reasoning = ?, cancel_reason = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """, (
            message,
            f"Overridden by user correction: {learning_notes}",
            draft_id
        ))
    else:
        # Ensure contact exists in contacts table
        cur.execute("INSERT OR IGNORE INTO contacts (contact, last_interaction) VALUES (?, CURRENT_TIMESTAMP)", (norm_phone,))
        cur.execute("""
        INSERT INTO followup_drafts (
            contact, drafted_msg, reasoning, intent, status, decision, category, rule_ids, cancel_reason, created_at, updated_at
        ) VALUES (?, ?, ?, 'USER_CORRECTION', 'MODIFIED', 'SEND', 'sales', '["SALES_01"]', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """, (
            norm_phone,
            message,
            f"User correction: {learning_notes}"
        ))
        draft_id = cur.lastrowid
        prev_status = "NEW"

    conn.commit()
    conn.close()

    # 3. Queue into send_queue if requested
    queue_id = None
    if queue_for_send and draft_id:
        queue_id = queue_draft_for_sending(draft_id, db_path=db_path)

    # 4. Record feedback in continuous learning RAG
    learning_id = record_feedback(
        contact=norm_phone,
        context_summary=context_summary,
        review_action="MODIFIED",
        original_draft=orig_draft,
        final_msg=message,
        reason_notes=learning_notes,
        client=client,
        embedding_model=embedding_model,
        source="MANUAL_REVIEW",
        category="sales",
        decision="SEND",
        rule_ids=["SALES_01"],
        db_path=db_path
    )

    return {
        "success": True,
        "contact": norm_phone,
        "draft_id": draft_id,
        "previous_status": prev_status,
        "message": message,
        "queue_id": queue_id,
        "learning_id": learning_id,
        "context_summary": context_summary,
        "reason_notes": learning_notes
    }


