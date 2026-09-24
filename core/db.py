"""
Database schema and persistence module for Fady_bot.
Uses SQLite for storage of chat messages, contacts, drafts, learning records, and send queue.
"""

import os
import sqlite3
import json
from typing import List, Dict, Any, Optional
from datetime import datetime


DEFAULT_DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "fady_bot.db")
DEFAULT_CANONICAL_JSONL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "feedback_learning_v2", "feedback_learning_v2.jsonl")


def get_db_connection(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    """Returns a sqlite3 connection with Row factory enabled."""
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(db_path: str = DEFAULT_DB_PATH) -> None:
    """Initializes the database schema if tables do not exist."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()

    # 1. Chats table: raw imported messages
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT,
        contact TEXT NOT NULL,
        profile_name TEXT,
        channel TEXT,
        direction TEXT NOT NULL,
        message TEXT,
        extracted_reply TEXT,
        reply_to TEXT,
        status TEXT,
        media_type TEXT,
        media_url TEXT,
        timestamp TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(chat_id, contact, timestamp)
    );
    """)

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chats_contact ON chats(contact);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chats_timestamp ON chats(timestamp);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chats_contact_timestamp ON chats(contact, timestamp);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chats_contact_timestamp_direction ON chats(contact, timestamp, direction);")

    # 2. Contacts table: summary per phone
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS contacts (
        contact TEXT PRIMARY KEY,
        profile_name TEXT,
        last_interaction TEXT,
        total_messages INTEGER DEFAULT 0,
        status TEXT DEFAULT 'ACTIVE',
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 3. Followup drafts: AI-generated drafts
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS followup_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact TEXT NOT NULL,
        drafted_msg TEXT,
        reasoning TEXT,
        intent TEXT,
        status TEXT DEFAULT 'PENDING',  -- PENDING, APPROVED, MODIFIED, CANCELLED, DEFERRED, HUMAN_REVIEW, SENT, FAILED
        cancel_reason TEXT,
        decision TEXT DEFAULT 'SEND',   -- SEND, SKIP, DEFER, HUMAN_REVIEW
        category TEXT DEFAULT '',       -- sales, support, guardrails, style
        rule_ids TEXT DEFAULT '[]',     -- JSON list of matched rule IDs
        internal_reason TEXT DEFAULT '',
        required_human_action TEXT,
        not_before TEXT,
        conversation_version TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(contact) REFERENCES contacts(contact)
    );
    """)

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_drafts_contact ON followup_drafts(contact);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_drafts_status ON followup_drafts(status);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_drafts_contact_status ON followup_drafts(contact, status);")

    # 4. Feedback learning: continuous learning & semantic RAG memory
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS feedback_learning (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact TEXT NOT NULL,
        context_summary TEXT NOT NULL,
        embedding_json TEXT,         -- JSON list of float values for cosine similarity
        original_draft TEXT,
        final_msg TEXT,              -- human revised message or empty if cancelled
        review_action TEXT NOT NULL, -- APPROVED, MODIFIED, CANCELLED, DEFERRED, HUMAN_REVIEW
        reason_notes TEXT,
        source TEXT DEFAULT 'MANUAL_REVIEW', -- MANUAL_REVIEW or STARTER_BATCH
        category TEXT DEFAULT '',            -- sales, support, guardrails, style, etc.
        decision TEXT DEFAULT '',            -- SEND, SKIP, DEFER, HUMAN_REVIEW
        original_decision TEXT,              -- model proposed decision
        corrected_decision TEXT,             -- reviewer chosen decision
        correction_type TEXT,                -- eligibility, factual_accuracy, wording, timing, capability
        reviewer_authority TEXT DEFAULT 'OPERATOR',
        rule_ids TEXT DEFAULT '[]',          -- JSON list of matched rule IDs
        required_human_action TEXT,
        not_before TEXT,
        conversation_version TEXT,
        state_snapshot TEXT,                 -- JSON state snapshot at review time
        catalogue_version TEXT DEFAULT '2.0.0',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_feedback_source ON feedback_learning(source);")

    # 5. Canonical rules table: canonical v2 rules from feedback_learning_v2
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS canonical_rules (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        decision_pattern TEXT NOT NULL,
        version TEXT DEFAULT '2.0.0',
        evidence_basis TEXT,
        required_evidence TEXT,      -- JSON list of required evidence statements
        reason TEXT NOT NULL,        -- Expanded reusable explanation
        exclusions TEXT,             -- JSON list of near misses / exclusions
        preferred_messages TEXT,     -- JSON object {english: [], lebanese_arabizi: []}
        retrieval_aliases TEXT,      -- JSON list of retrieval aliases
        runtime_note TEXT,
        embedding_text TEXT,
        embedding_json TEXT,         -- JSON list of float values
        content_sha256 TEXT,
        source_records TEXT,         -- JSON list of source references
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_canonical_category ON canonical_rules(category);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_canonical_decision ON canonical_rules(decision_pattern);")

    # 6. Send queue: scheduled and dispatched messages
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS send_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        draft_id INTEGER,
        contact TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT DEFAULT 'QUEUED', -- QUEUED, SENDING, SENT, FAILED
        attempts INTEGER DEFAULT 0,
        api_response TEXT,
        scheduled_at TEXT DEFAULT CURRENT_TIMESTAMP,
        sent_at TEXT,
        error_message TEXT,
        FOREIGN KEY(draft_id) REFERENCES followup_drafts(id)
    );
    """)

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_send_queue_status ON send_queue(status);")

    # 7. Config / Settings KV store
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS config_store (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 8. Processed files table: tracks ingested CSV exports and auto-backups
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS processed_files (
        filename TEXT PRIMARY KEY,
        file_size INTEGER,
        last_modified REAL,
        records_imported INTEGER DEFAULT 0,
        duplicates INTEGER DEFAULT 0,
        processed_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # Schema migration: Add missing columns to existing tables
    _migrate_schema_columns(cursor)

    conn.commit()

    # Automatically load canonical rules if canonical_rules table is empty
    cursor.execute("SELECT COUNT(*) FROM canonical_rules")
    if cursor.fetchone()[0] == 0:
        load_canonical_rules(conn=conn)

    conn.close()


def _migrate_schema_columns(cursor: sqlite3.Cursor) -> None:
    """Safely adds missing columns to existing tables for backwards compatibility."""
    cursor.execute("PRAGMA table_info(followup_drafts)")
    draft_cols = {row[1] for row in cursor.fetchall()}
    
    new_draft_cols = [
        ("decision", "TEXT DEFAULT 'SEND'"),
        ("category", "TEXT DEFAULT ''"),
        ("rule_ids", "TEXT DEFAULT '[]'"),
        ("internal_reason", "TEXT DEFAULT ''"),
        ("required_human_action", "TEXT"),
        ("not_before", "TEXT"),
        ("conversation_version", "TEXT"),
    ]
    for col_name, col_type in new_draft_cols:
        if col_name not in draft_cols:
            cursor.execute(f"ALTER TABLE followup_drafts ADD COLUMN {col_name} {col_type};")

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_drafts_decision ON followup_drafts(decision);")

    cursor.execute("PRAGMA table_info(feedback_learning)")
    feedback_cols = {row[1] for row in cursor.fetchall()}

    new_feedback_cols = [
        ("decision", "TEXT DEFAULT ''"),
        ("original_decision", "TEXT"),
        ("corrected_decision", "TEXT"),
        ("correction_type", "TEXT"),
        ("reviewer_authority", "TEXT DEFAULT 'OPERATOR'"),
        ("rule_ids", "TEXT DEFAULT '[]'"),
        ("required_human_action", "TEXT"),
        ("not_before", "TEXT"),
        ("conversation_version", "TEXT"),
        ("state_snapshot", "TEXT"),
        ("catalogue_version", "TEXT DEFAULT '2.0.0'"),
    ]
    for col_name, col_type in new_feedback_cols:
        if col_name not in feedback_cols:
            cursor.execute(f"ALTER TABLE feedback_learning ADD COLUMN {col_name} {col_type};")

    cursor.execute("PRAGMA table_info(contacts)")
    contacts_cols = {row[1] for row in cursor.fetchall()}
    for col_name, col_type in [("not_before", "TEXT"), ("notes", "TEXT")]:
        if col_name not in contacts_cols:
            cursor.execute(f"ALTER TABLE contacts ADD COLUMN {col_name} {col_type};")

    cursor.execute("PRAGMA table_info(chats)")
    chats_cols = {row[1] for row in cursor.fetchall()}
    if "sent_by" not in chats_cols:
        cursor.execute("ALTER TABLE chats ADD COLUMN sent_by TEXT DEFAULT '';")


def record_processed_file(filename: str, file_size: int, last_modified: float, records_imported: int, duplicates: int = 0, db_path: str = DEFAULT_DB_PATH) -> None:
    """Records or updates an imported file in processed_files table."""
    conn = get_db_connection(db_path)
    cur = conn.cursor()
    cur.execute("""
    INSERT OR REPLACE INTO processed_files (filename, file_size, last_modified, records_imported, duplicates, processed_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    """, (os.path.basename(filename), file_size, last_modified, records_imported, duplicates))
    conn.commit()
    conn.close()


def is_file_processed(filename: str, file_size: int, last_modified: float, db_path: str = DEFAULT_DB_PATH) -> bool:
    """Checks if a file with matching name, size and modification time was already processed."""
    conn = get_db_connection(db_path)
    cur = conn.cursor()
    cur.execute("""
    SELECT 1 FROM processed_files
    WHERE filename = ? AND file_size = ? AND abs(last_modified - ?) < 1.0
    """, (os.path.basename(filename), file_size, last_modified))
    res = cur.fetchone()
    conn.close()
    return res is not None


def get_processed_files_count(db_path: str = DEFAULT_DB_PATH) -> int:
    """Returns total number of processed files."""
    try:
        conn = get_db_connection(db_path)
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM processed_files")
        count = cur.fetchone()[0]
        conn.close()
        return count
    except Exception:
        return 0


def get_processed_files(db_path: str = DEFAULT_DB_PATH) -> List[Dict[str, Any]]:
    """Returns list of all processed files with their stats."""
    try:
        conn = get_db_connection(db_path)
        cur = conn.cursor()
        cur.execute("SELECT filename, file_size, last_modified, records_imported, duplicates, processed_at FROM processed_files ORDER BY processed_at DESC")
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows
    except Exception:
        return []


def save_config_value(key: str, value: Any, db_path: str = DEFAULT_DB_PATH) -> None:
    """Saves a key-value setting to the database."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    val_str = json.dumps(value) if not isinstance(value, str) else value
    cursor.execute("""
    INSERT INTO config_store (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
    """, (key, val_str))
    conn.commit()
    conn.close()


def get_config_value(key: str, default: Any = None, db_path: str = DEFAULT_DB_PATH) -> Any:
    """Gets a key-value setting from the database."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM config_store WHERE key = ?", (key,))
    row = cursor.fetchone()
    conn.close()
    if not row:
        return default
    try:
        return json.loads(row["value"])
    except Exception:
        return row["value"]


def load_canonical_rules(
    jsonl_path: str = DEFAULT_CANONICAL_JSONL,
    db_path: str = DEFAULT_DB_PATH,
    conn: Optional[sqlite3.Connection] = None,
    overwrite: bool = True
) -> int:
    """
    Ingests canonical rule cards from feedback_learning_v2.jsonl into canonical_rules table.
    Stores the full structured card payload, embedding text, retrieval aliases, and reasons.
    """
    if not os.path.exists(jsonl_path):
        return 0

    close_conn = False
    if conn is None:
        conn = get_db_connection(db_path)
        close_conn = True

    cursor = conn.cursor()
    loaded_count = 0

    with open(jsonl_path, "r", encoding="utf-8") as f:
        for line in f:
            line_str = line.strip()
            if not line_str:
                continue
            try:
                card = json.loads(line_str)
            except Exception:
                continue

            rule_id = card.get("id")
            if not rule_id:
                continue

            cursor.execute("""
            INSERT INTO canonical_rules (
                id, title, category, decision_pattern, version, evidence_basis,
                required_evidence, reason, exclusions, preferred_messages,
                retrieval_aliases, runtime_note, embedding_text, embedding_json,
                content_sha256, source_records, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                category = excluded.category,
                decision_pattern = excluded.decision_pattern,
                version = excluded.version,
                evidence_basis = excluded.evidence_basis,
                required_evidence = excluded.required_evidence,
                reason = excluded.reason,
                exclusions = excluded.exclusions,
                preferred_messages = excluded.preferred_messages,
                retrieval_aliases = excluded.retrieval_aliases,
                runtime_note = excluded.runtime_note,
                embedding_text = excluded.embedding_text,
                content_sha256 = excluded.content_sha256,
                source_records = excluded.source_records
            """, (
                rule_id,
                card.get("title", ""),
                card.get("category", ""),
                card.get("decision", ""),
                card.get("version", "2.0.0"),
                card.get("evidence_basis", ""),
                json.dumps(card.get("required_evidence", [])),
                card.get("reason", ""),
                json.dumps(card.get("exclusions_and_near_misses", [])),
                json.dumps(card.get("preferred_messages", {})),
                json.dumps(card.get("retrieval_aliases", [])),
                card.get("runtime_note", ""),
                card.get("embedding_text", ""),
                json.dumps(card.get("embedding", [])) if card.get("embedding") else "",
                card.get("content_sha256", ""),
                json.dumps(card.get("source_records", []))
            ))
            loaded_count += 1

    conn.commit()
    if close_conn:
        conn.close()

    return loaded_count


def delete_unsent_drafts(
    include_cancelled: bool = False,
    db_path: str = DEFAULT_DB_PATH
) -> Dict[str, int]:
    """
    Permanently deletes unsent drafts and queued messages from the database.
    Strictly preserves all sent messages, sent drafts, chat history, contacts, and learning records.

    Args:
        include_cancelled: If True, also removes cancelled follow-ups. Defaults to False.
        db_path: Path to SQLite database file.

    Returns:
        Dict with count of deleted drafts and deleted queued messages:
        {"deleted_drafts": int, "deleted_queued_messages": int}
    """
    conn = get_db_connection(db_path)
    cursor = conn.cursor()

    if include_cancelled:
        draft_status_clause = "status != 'SENT'"
    else:
        draft_status_clause = "status IN ('PENDING', 'APPROVED', 'MODIFIED', 'DEFERRED', 'HUMAN_REVIEW')"

    # 1. Delete queued/unsent messages from send_queue (strictly protect SENT messages)
    cursor.execute(f"""
    DELETE FROM send_queue
    WHERE status != 'SENT'
      AND (
          status IN ('QUEUED', 'SENDING')
          OR draft_id IN (SELECT id FROM followup_drafts WHERE {draft_status_clause})
      )
    """)
    deleted_queue = cursor.rowcount

    # 2. Delete unsent drafts from followup_drafts (strictly protect SENT drafts)
    cursor.execute(f"""
    DELETE FROM followup_drafts
    WHERE {draft_status_clause}
    """)
    deleted_drafts = cursor.rowcount

    conn.commit()
    conn.close()

    return {
        "deleted_drafts": deleted_drafts,
        "deleted_queued_messages": deleted_queue
    }

