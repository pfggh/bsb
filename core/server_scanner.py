#!/usr/bin/env python3
"""
core/server_scanner.py - Server-Side AI Follow-up Scanner for Teshrij Suite
Uses full Fady_bot rules, pgvector canonical retrieval, and multi-threaded OpenAI analysis.
Runs completely server-side, independent of the browser UI.
"""

import os
import sys
import json
import time
import re
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed
import psycopg2
from psycopg2.extras import RealDictCursor
from openai import OpenAI

DB_URL = "postgresql://postgres.kfgswynickhywzhneltu:raise%20unable%20duck%20fanatical%20arrest%20yard%20maid%20stunner%20truffle@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POLICY_PATH = os.path.join(BASE_DIR, "feedback_learning_v2", "runtime_policy.txt")
PROMPT_PATH = os.path.join(BASE_DIR, "prompts", "system_prompt.txt")


def get_db():
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = True
    return conn


def is_fixed_temperature_model(model_name: str) -> bool:
    if not model_name:
        return False
    m = model_name.lower().strip()
    base_model = m.split("/")[-1].split("\\")[-1]
    return (
        base_model.startswith(("o1", "o2", "o3", "o4", "gpt-5"))
        or "-o1" in base_model
        or "-o3" in base_model
        or "-o4" in base_model
        or "gpt-5" in base_model
    )


def get_openai_client_and_model() -> tuple[OpenAI, str]:
    api_key = os.environ.get("OPENAI_API_KEY")
    chat_model = "gpt-4o"
    conn = get_db()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("SELECT value FROM followup_config WHERE key = 'openai'")
    row = cur.fetchone()
    cur.close()
    conn.close()
    if row and row.get("value"):
        if not api_key:
            api_key = row["value"].get("api_key")
        chat_model = row["value"].get("chat_model") or "gpt-4o"
    if not api_key:
        raise ValueError("OPENAI_API_KEY not configured in environment or followup_config.")
    return OpenAI(api_key=api_key), chat_model


def load_instructions() -> str:
    policy = ""
    if os.path.exists(POLICY_PATH):
        with open(POLICY_PATH, "r", encoding="utf-8") as f:
            policy = f.read().strip()

    prompt_base = ""
    if os.path.exists(PROMPT_PATH):
        with open(PROMPT_PATH, "r", encoding="utf-8") as f:
            prompt_base = f.read().strip()

    parts = []
    if policy:
        parts.append(policy)
    if prompt_base:
        parts.append(prompt_base)

    combined = "\n\n".join(parts).strip()
    return combined or "You are an intelligent WhatsApp follow-up assistant. Respond strictly in valid JSON format."


# ============================================================================
# Heuristic Guards & Domain Policy Checks (from Fady_bot core/analyzer.py)
# ============================================================================

def evaluate_heuristics(messages: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Evaluates strict heuristic pre-checks before LLM inference to save time and prevent rule breaches."""
    if not messages:
        return {"decision": "SKIP", "reason": "No message history"}

    last_msg = messages[-1]
    last_text = (last_msg.get("message") or "").strip().lower()
    last_direction = (last_msg.get("direction") or "").lower()

    all_text = " ".join((m.get("message") or "").lower() for m in messages)

    # 1. Anghami Login Check Prevention (SUPPORT_12)
    # Anghami activation uses invitation link / screenshot, NEVER login credentials or password
    if "anghami" in all_text:
        if any(w in last_text for w in ["password", "credentials", "fout 3al account", "login", "log in"]):
            return {
                "decision": "SKIP",
                "category": "support",
                "rule_ids": ["SUPPORT_12"],
                "reason": "SUPPORT_12: Anghami does not use login credentials or password login."
            }

    # 2. Repeated Support Outcome Check Prevention (SUPPORT_01)
    # If business already asked "meshe l hal / did it work" and customer hasn't answered, DO NOT repeat
    if last_direction in ("outgoing", "outbound"):
        if any(w in last_text for w in ["meshe l hal", "meche l hal", "did it work", "zabat", "2dert tfout", "were you able"]):
            return {
                "decision": "SKIP",
                "category": "support",
                "rule_ids": ["SUPPORT_01"],
                "reason": "SUPPORT_01: Support outcome check was already sent and is pending customer response."
            }

    # 3. Explicit Refusal or Customer Controlled Stop (SALES_10, SALES_11)
    if last_direction in ("incoming", "inbound"):
        if any(w in last_text for w in ["no thanks", "no thx", "khalas ma baddi", "not interested", "ma baddi"]):
            return {
                "decision": "SKIP",
                "category": "sales",
                "rule_ids": ["SALES_10"],
                "reason": "SALES_10: Customer explicitly declined."
            }
        if any(w in last_text for w in ["bredelkon khabar", "breddelkon khabar", "later thanks", "not now", "not at the moment"]):
            return {
                "decision": "SKIP",
                "category": "sales",
                "rule_ids": ["SALES_11"],
                "reason": "SALES_11: Customer deferral (bredelkon khabar). Stop follow-up."
            }

    # 4. Implicit Confirmation of Resolution (SUPPORT_04)
    # Customer said "thank you / merci / thx / done" after remedy
    if last_direction in ("incoming", "inbound") and len(messages) >= 2:
        if any(last_text == w or last_text.startswith(w + " ") for w in ["thank you", "thanks", "thx", "merci", "done", "all good", "tamam", "khalas"]):
            prev = messages[-2]
            prev_dir = (prev.get("direction") or "").lower()
            if prev_dir in ("outgoing", "outbound"):
                return {
                    "decision": "SKIP",
                    "category": "support",
                    "rule_ids": ["SUPPORT_04"],
                    "reason": "SUPPORT_04: Customer acknowledgment after remedy constitutes implicit confirmation of resolution."
                }

    return None


def sanitize_message(msg: Optional[str]) -> Optional[str]:
    """Sanitizes candidate message to enforce safety rules (no URLs, no emails, no fake promises)."""
    if not msg or not msg.strip():
        return None
    # Block raw URLs
    if re.search(r"https?://|www\.", msg, re.I):
        return None
    # Block emails
    if re.search(r"[\w.-]+@[\w.-]+\.\w+", msg):
        return None
    # Block placeholder tokens
    if re.search(r"\[(?:price|product|plan|duration|link|name)\]", msg, re.I):
        return None
    # Block unauthorized operational claims
    if re.search(r"\b(?:i will fix|we will activate|refund sent|fixed it from the system)\b", msg, re.I):
        return None
    return msg.strip()


# ============================================================================
# Single Contact Evaluation Task
# ============================================================================

def process_single_contact(contact: str, profile_name: str, conn_str: str, client: OpenAI, instructions: str, chat_model: str = "gpt-4o") -> Dict[str, Any]:
    conn = psycopg2.connect(conn_str)
    conn.autocommit = True
    cur = conn.cursor(cursor_factory=RealDictCursor)

    try:
        # Fetch last 12 messages
        cur.execute("""
            SELECT direction, message, timestamp, status
            FROM bsb_messages
            WHERE contact = %s
            ORDER BY timestamp ASC
            LIMIT 14
        """, (contact,))
        msgs = cur.fetchall()

        if not msgs:
            return {"contact": contact, "decision": "SKIP", "reason": "No messages"}

        # Run fast heuristic checks
        heuristic = evaluate_heuristics(msgs)
        if heuristic:
            dec = heuristic["decision"]
            cat = heuristic.get("category", "support")
            r_ids = heuristic.get("rule_ids", [])
            reason = heuristic.get("reason", "")
            status = "CANCELLED" if dec == "SKIP" else "PENDING"

            cur.execute("""
                INSERT INTO followup_drafts (contact, profile_name, drafted_msg, reasoning, decision, category, rule_ids, internal_reason, status)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (contact, profile_name, None, reason, dec, cat, json.dumps(r_ids), reason, status))

            return {"contact": contact, "decision": dec, "rule_ids": r_ids, "status": status}

        # Build transcript
        transcript_lines = []
        for m in msgs:
            sender = "Customer" if (m.get("direction") or "").lower() in ("incoming", "inbound") else "Business"
            text = m.get("message") or "[Media / Voice Note]"
            transcript_lines.append(f"{sender}: {text}")
        conv_text = "\n".join(transcript_lines)

        # Vector search matching canonical rules
        query_vector = []
        try:
            emb_resp = client.embeddings.create(input=[conv_text[-500:]], model="text-embedding-3-small")
            query_vector = emb_resp.data[0].embedding
        except Exception:
            pass

        matched_rules = []
        if query_vector:
            cur.execute("""
                SELECT id, title, category, reason, preferred_messages
                FROM match_canonical_rules(%s::vector, 0.25, 4)
            """, (str(query_vector),))
            matched_rules = cur.fetchall()

        rules_str = ""
        if matched_rules:
            r_lines = []
            for r in matched_rules:
                pref = r.get("preferred_messages") or {}
                if isinstance(pref, str):
                    try:
                        pref = json.loads(pref)
                    except Exception:
                        pref = {}
                arabizi = pref.get("lebanese_arabizi", [])
                arabizi_txt = f" (Preferred Arabizi: {arabizi})" if arabizi else ""
                r_lines.append(f"- [{r['id']}] {r['title']}: {r['reason']}{arabizi_txt}")
            rules_str = "\n".join(r_lines)

        # Call OpenAI with strict contract
        system_content = f"""{instructions}

### RELEVANT CANONICAL RULES (v2.0):
{rules_str}

### RESPONSE JSON CONTRACT:
You must respond strictly with a valid JSON object:
{{
  "decision": "SEND" | "SKIP" | "DEFER" | "HUMAN_REVIEW",
  "category": "sales" | "support" | "guardrails" | "style",
  "message": "followup text in clean English or Lebanese Arabizi" or null,
  "rule_ids": ["RULE_ID_1"],
  "internal_reason": "Detailed explanation"
}}
RULES:
- Only 'SEND' may contain a message. For 'SKIP', message must be null.
- Never output raw links, fake email addresses, or unvetted prices.
"""

        req_params = {
            "model": chat_model or "gpt-4o",
            "messages": [
                {"role": "system", "content": system_content},
                {"role": "user", "content": f"Customer phone: {contact}\nProfile Name: {profile_name}\n\nCONVERSATION HISTORY:\n{conv_text}\n\nEvaluate decision:"}
            ],
            "response_format": {"type": "json_object"},
            "max_tokens": 250
        }
        if not is_fixed_temperature_model(req_params["model"]):
            req_params["temperature"] = 0.7

        res = client.chat.completions.create(**req_params)

        draft = json.loads(res.choices[0].message.content)
        decision = draft.get("decision", "SKIP").upper()
        if decision not in ("SEND", "SKIP", "DEFER", "HUMAN_REVIEW"):
            decision = "SKIP"
        category = draft.get("category", "sales")
        message = sanitize_message(draft.get("message")) if decision == "SEND" else None
        rule_ids = draft.get("rule_ids") or []
        internal_reason = draft.get("internal_reason", "")

        status = "PENDING" if decision in ("SEND", "HUMAN_REVIEW") else "CANCELLED"

        cur.execute("""
            INSERT INTO followup_drafts (contact, profile_name, drafted_msg, reasoning, decision, category, rule_ids, internal_reason, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (contact, profile_name, message, internal_reason, decision, category, json.dumps(rule_ids), internal_reason, status))

        return {
            "contact": contact,
            "decision": decision,
            "message": message,
            "rule_ids": rule_ids,
            "status": status
        }

    except Exception as e:
        return {"contact": contact, "decision": "ERROR", "error": str(e)}
    finally:
        cur.close()
        conn.close()


# ============================================================================
# Main Server Scan Execution
# ============================================================================

def execute_server_scan(limit: Optional[int] = None, job_id: Optional[int] = None) -> Dict[str, Any]:
    """
    Executes a complete server-side AI scan against eligible contacts.
    Scans all eligible contacts if limit is None.
    Updates scan_jobs table if job_id is provided.
    """
    conn = get_db()
    cur = conn.cursor(cursor_factory=RealDictCursor)

    if job_id:
        cur.execute("UPDATE scan_jobs SET status = 'RUNNING', started_at = NOW() WHERE id = %s", (job_id,))

    print(f"\n[SERVER SCANNER] Querying eligible 24h contacts (≥2h old) from bsb_messages...")

    # 1. Fetch active conversations
    cur.execute("""
        SELECT DISTINCT contact, MAX(profile_name) as profile_name, MAX(timestamp) as last_ts
        FROM bsb_messages
        WHERE timestamp >= NOW() - INTERVAL '24 hours'
        GROUP BY contact
        HAVING MAX(timestamp) <= NOW() - INTERVAL '2 hours'
        ORDER BY last_ts DESC
    """)
    candidates = cur.fetchall()

    # 2. Filter out contacts with drafts created in past 24 hours
    cur.execute("""
        SELECT DISTINCT contact
        FROM followup_drafts
        WHERE created_at >= NOW() - INTERVAL '24 hours'
    """)
    existing_contacts = {r["contact"] for r in cur.fetchall()}

    eligible = [c for c in candidates if c["contact"] not in existing_contacts]
    if limit:
        eligible = eligible[:limit]

    total_eligible = len(eligible)
    print(f"[SERVER SCANNER] Found {total_eligible} eligible contacts to evaluate.")

    if total_eligible == 0:
        if job_id:
            cur.execute("""
                UPDATE scan_jobs 
                SET status = 'COMPLETED', completed_at = NOW(), total_evaluated = 0, drafts_created = 0, skipped = 0
                WHERE id = %s
            """, (job_id,))
        cur.close()
        conn.close()
        return {"total_evaluated": 0, "drafts_created": 0, "skipped": 0, "human_review": 0}

    client, chat_model = get_openai_client_and_model()
    instructions = load_instructions()

    stats = {"total_evaluated": 0, "drafts_created": 0, "skipped": 0, "human_review": 0, "errors": 0}

    # Multi-threaded execution (5 parallel workers for 0 lag)
    max_workers = 5
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(
                process_single_contact,
                c["contact"],
                c.get("profile_name") or "",
                DB_URL,
                client,
                instructions,
                chat_model
            ): c["contact"] for c in eligible
        }

        completed_count = 0
        for future in as_completed(futures):
            res = future.result()
            stats["total_evaluated"] += 1
            completed_count += 1

            dec = res.get("decision")
            if dec == "SEND":
                stats["drafts_created"] += 1
            elif dec == "HUMAN_REVIEW":
                stats["human_review"] += 1
            elif dec == "SKIP":
                stats["skipped"] += 1
            else:
                stats["errors"] += 1

            print(f"[{completed_count}/{total_eligible}] Evaluated {res.get('contact')} -> {dec} ({res.get('status')})")

            # Intermediate progress update on scan_jobs
            if job_id and completed_count % 5 == 0:
                cur.execute("""
                    UPDATE scan_jobs 
                    SET total_evaluated = %s, drafts_created = %s, skipped = %s, human_review = %s
                    WHERE id = %s
                """, (stats["total_evaluated"], stats["drafts_created"], stats["skipped"], stats["human_review"], job_id))

    if job_id:
        cur.execute("""
            UPDATE scan_jobs 
            SET status = 'COMPLETED', completed_at = NOW(), 
                total_evaluated = %s, drafts_created = %s, skipped = %s, human_review = %s
            WHERE id = %s
        """, (stats["total_evaluated"], stats["drafts_created"], stats["skipped"], stats["human_review"], job_id))

    cur.close()
    conn.close()

    print(f"\n[SERVER SCANNER COMPLETE] Total Evaluated: {stats['total_evaluated']}, Drafts Created: {stats['drafts_created']}, Skipped: {stats['skipped']}, Human Review: {stats['human_review']}")
    return stats


# ============================================================================
# Queue Dispatcher (Server-Side)
# ============================================================================

def is_beirut_working_hours() -> bool:
    beirut_tz = timezone(timedelta(hours=3))
    now = datetime.now(beirut_tz)
    return 9 <= now.hour < 21


def normalize_phone(phone_str: str) -> str:
    if not phone_str:
        return ""
    digits = re.sub(r"\D", "", str(phone_str).strip())
    if digits.startswith("00"):
        digits = digits[2:]
    if digits.startswith("961"):
        rest = digits[3:]
        if rest.startswith("03") and len(rest) == 8:
            return "961" + rest[1:]
        return digits
    if len(digits) == 8 and digits.startswith("03"):
        return "961" + digits[1:]
    if len(digits) == 7 and digits.startswith("3"):
        return "961" + digits
    if len(digits) in (7, 8) and digits[0] in ("7", "8"):
        return "961" + digits
    return digits


def process_server_queue(max_items: int = 15):
    """Dispatches QUEUED messages from send_queue respecting 1.5s delay and working hours."""
    if not is_beirut_working_hours():
        return

    import requests
    conn = get_db()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("SELECT * FROM send_queue WHERE status = 'QUEUED' ORDER BY scheduled_at ASC LIMIT %s", (max_items,))
    items = cur.fetchall()

    if not items:
        cur.close()
        conn.close()
        return

    print(f"[QUEUE DISPATCHER] Found {len(items)} queued follow-up messages. Dispatching (1.5s delay)...")

    for item in items:
        qid = item["id"]
        contact = item["contact"]
        msg = item["message"]
        norm = normalize_phone(contact)

        try:
            resp = requests.post(
                "https://www.bestsmsbulk.com/bestsmsbulkapi/whatsappmsging/sendMessage.php",
                json={
                    "api_key": "teshrij",
                    "api_secret": "Teshrij123",
                    "destination": norm,
                    "message": msg
                },
                timeout=12
            )
            res_json = resp.json()
            if resp.status_code == 200 and res_json.get("status") != "error" and res_json.get("success") is not False:
                cur.execute("UPDATE send_queue SET status = 'SENT', sent_at = NOW(), api_response = %s WHERE id = %s", (json.dumps(res_json), qid))
                if item.get("draft_id"):
                    cur.execute("UPDATE followup_drafts SET status = 'SENT' WHERE id = %s", (item["draft_id"],))
                print(f"[QUEUE DISPATCHER] ✓ Dispatched to {norm}")
            else:
                cur.execute("UPDATE send_queue SET status = 'FAILED', attempts = COALESCE(attempts,0) + 1, error_message = %s WHERE id = %s", (json.dumps(res_json), qid))
                print(f"[QUEUE DISPATCHER] ❌ Failed to {norm}: {res_json}")
        except Exception as e:
            cur.execute("UPDATE send_queue SET status = 'FAILED', attempts = COALESCE(attempts,0) + 1, error_message = %s WHERE id = %s", (str(e), qid))
            print(f"[QUEUE DISPATCHER] ❌ Error to {norm}: {e}")

        time.sleep(1.5)

    cur.close()
    conn.close()


def run_server_daemon(interval_minutes: int = 15):
    """
    Continuous server-side daemon.
    1. Listens for pending scan_jobs submitted by the Web UI.
    2. Runs scheduled scan every interval_minutes.
    3. Dispatches send_queue with 1.5s delay.
    """
    print(f"================================================================")
    print(f" Teshrij Server-Side Follow-up Automation Daemon Started")
    print(f" Periodic Scan: Every {interval_minutes} minutes")
    print(f" On-Demand UI Listener: Active (polling scan_jobs)")
    print(f" Queue Dispatcher: Active (1.5s delay, 9 AM - 9 PM Beirut)")
    print(f"================================================================")

    last_scheduled_scan = datetime.now(timezone.utc) - timedelta(minutes=interval_minutes + 1)
    last_queue_check = 0

    while True:
        try:
            # 1. Check for on-demand job requested from Web UI
            conn = get_db()
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("SELECT id FROM scan_jobs WHERE status = 'PENDING' ORDER BY requested_at ASC LIMIT 1 FOR UPDATE")
            pending_job = cur.fetchone()
            cur.close()
            conn.close()

            if pending_job:
                job_id = pending_job["id"]
                print(f"[DAEMON] Detected on-demand scan request (Job #{job_id}). Executing server-side scan...")
                execute_server_scan(limit=None, job_id=job_id)
                last_scheduled_scan = datetime.now(timezone.utc)

            # 2. Check if periodic scheduled scan is due
            now = datetime.now(timezone.utc)
            if (now - last_scheduled_scan).total_seconds() >= interval_minutes * 60:
                print(f"[DAEMON] {interval_minutes}-minute scheduled automation interval reached. Starting automated server scan...")
                execute_server_scan(limit=None)
                last_scheduled_scan = now

            # 3. Process send queue every 15 seconds
            if time.time() - last_queue_check >= 15:
                process_server_queue()
                last_queue_check = time.time()

        except Exception as e:
            print(f"[DAEMON ERROR] {e}")

        # Sleep 2 seconds before checking next job
        time.sleep(2.0)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--daemon":
        run_server_daemon(interval_minutes=15)
    else:
        execute_server_scan(limit=None)
