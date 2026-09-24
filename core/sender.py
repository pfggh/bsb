"""
WhatsApp Message Dispatcher via BestSMSBulk API.
Handles immediate and queued sending, rate limit delays, retry attempts,
and supports both Manual Review Mode and Automatic Unreviewed Mode.
"""

import time
import json
import logging
from typing import Dict, Any, List, Optional
import requests
from core.db import get_db_connection, DEFAULT_DB_PATH, delete_unsent_drafts
from core.importer import normalize_phone


logger = logging.getLogger(__name__)


def send_whatsapp_message(
    destination: str,
    message: str,
    api_endpoint: str = "https://www.bestsmsbulk.com/bestsmsbulkapi/whatsappmsging/sendMessage.php",
    api_key: str = "teshrij",
    api_secret: str = "Teshrij123",
    timeout: int = 25
) -> Dict[str, Any]:
    """
    Sends a WhatsApp session message via BestSMSBulk API.
    Normalizes phone number and handles API response.
    """
    norm_dest = normalize_phone(destination)
    if not norm_dest:
        return {"success": False, "message": f"Invalid destination phone number: {destination}"}

    payload = {
        "api_key": api_key,
        "api_secret": api_secret,
        "destination": norm_dest,
        "message": message
    }
    headers = {"Content-Type": "application/json"}

    try:
        response = requests.post(api_endpoint, json=payload, headers=headers, timeout=timeout)
        try:
            res_json = response.json()
        except Exception:
            res_json = {"raw_response": response.text}
        
        if isinstance(res_json, dict):
            res_json["status_code"] = response.status_code

            # Identify any error conditions from BestSMSBulk API or HTTP status
            has_error = False
            err_reason = None
            if response.status_code != 200:
                has_error = True
                err_reason = f"HTTP {response.status_code}: {response.text[:120]}"
            else:
                st_val = str(res_json.get("status", "")).strip().lower()
                succ_val = res_json.get("success")
                raw_resp = str(res_json.get("raw_response", "")).strip()

                if st_val in ["error", "failed", "failure", "0", "false"]:
                    has_error = True
                    err_reason = res_json.get("message") or res_json.get("error") or "API reported error status"
                elif "error" in res_json and res_json["error"]:
                    has_error = True
                    err_reason = str(res_json["error"])
                elif succ_val in [False, "false", "False", 0, "0"]:
                    has_error = True
                    err_reason = res_json.get("message") or "API returned success=False"
                elif raw_resp and any(k in raw_resp.lower() for k in ["error", "failed", "failure", "invalid", "unauthorized", "insufficient"]):
                    has_error = True
                    err_reason = f"API error in response: {raw_resp[:120]}"

            if has_error:
                res_json["success"] = False
                if err_reason and not res_json.get("message"):
                    res_json["message"] = err_reason
            else:
                if "success" not in res_json:
                    res_json["success"] = (response.status_code == 200)
        else:
            res_json = {
                "success": (response.status_code == 200),
                "data": res_json,
                "status_code": response.status_code
            }

        return res_json
    except Exception as e:
        return {"success": False, "message": f"Network/HTTP Exception: {str(e)}", "error": str(e)}


def queue_draft_for_sending(draft_id: int, db_path: str = DEFAULT_DB_PATH) -> Optional[int]:
    """
    Enforces application-level dispatch gates (GUARD_15 & Runtime Policy) and
    adds an approved/modified draft into the send_queue table:
    - Verifies draft has decision='SEND' (or status in 'APPROVED', 'MODIFIED', 'PENDING')
    - Verifies message body is non-empty
    - Gate 1: contact_allowed (contact is not opted-out or suppressed)
    - Gate 2: duplicate_pending (no duplicate pending/sending item in queue for contact)
    - Gate 3: conversation_unchanged (no new customer incoming message arrived after draft creation)
    - Gate 4: format and operational claim dispatch gates (validate_dispatch_gate)
    """
    from core.analyzer import validate_dispatch_gate

    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute("""
    SELECT id, contact, drafted_msg, status, decision, created_at, updated_at
    FROM followup_drafts
    WHERE id = ?
    """, (draft_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        return None

    contact = row["contact"]
    message = (row["drafted_msg"] or "").strip()
    status = (row["status"] or "").upper()
    decision = (row["decision"] or "").upper()
    draft_time = row["updated_at"] or row["created_at"]

    # Only SEND decisions or approved/modified/pending drafts can be queued
    if status not in ("APPROVED", "MODIFIED", "PENDING") and decision != "SEND":
        conn.close()
        return None

    if not message:
        conn.close()
        return None

    # Gate 1: contact_allowed
    cursor.execute("SELECT status FROM contacts WHERE contact = ?", (contact,))
    c_row = cursor.fetchone()
    if c_row and (c_row["status"] or "").upper() in ("OPT_OUT", "SUPPRESSED", "BLOCKED", "INACTIVE"):
        cursor.execute("UPDATE followup_drafts SET status = 'CANCELLED', decision = 'SKIP', cancel_reason = 'Contact opted out or suppressed' WHERE id = ?", (draft_id,))
        conn.commit()
        conn.close()
        return None

    # Gate 2: duplicate_pending (idempotency check)
    cursor.execute("""
    SELECT id FROM send_queue
    WHERE contact = ? AND status IN ('QUEUED', 'SENDING')
    """, (contact,))
    existing_q = cursor.fetchone()
    if existing_q:
        conn.close()
        return existing_q["id"]

    # Gate 3: conversation_unchanged (check if customer sent new message after draft was created)
    cursor.execute("""
    SELECT MAX(timestamp) FROM chats
    WHERE contact = ? AND UPPER(direction) = 'INCOMING'
    """, (contact,))
    last_incoming_row = cursor.fetchone()
    if last_incoming_row and last_incoming_row[0] and draft_time:
        if str(last_incoming_row[0]) > str(draft_time):
            cursor.execute("""
            UPDATE followup_drafts
            SET status = 'CANCELLED', decision = 'SKIP',
                cancel_reason = 'New customer message arrived after draft creation (GUARD_15)'
            WHERE id = ?
            """, (draft_id,))
            conn.commit()
            conn.close()
            return None

    # Gate 4: format and operational claim dispatch gates
    v2_dec, clean_msg, gate_issue = validate_dispatch_gate("SEND", message)
    if gate_issue or v2_dec != "SEND":
        cursor.execute("""
        UPDATE followup_drafts
        SET status = 'CANCELLED', decision = 'SKIP',
            cancel_reason = ?
        WHERE id = ?
        """, (f"Dispatch gate issue: {gate_issue}", draft_id))
        conn.commit()
        conn.close()
        return None

    cursor.execute("""
    INSERT INTO send_queue (draft_id, contact, message, status, scheduled_at)
    VALUES (?, ?, ?, 'QUEUED', CURRENT_TIMESTAMP)
    """, (draft_id, contact, clean_msg))
    queue_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return queue_id


def process_send_queue(
    config: Dict[str, Any],
    dry_run: bool = False,
    limit: Optional[int] = None,
    stop_event: Optional[Any] = None,
    progress_callback: Optional[Any] = None,
    db_path: str = DEFAULT_DB_PATH
) -> Dict[str, Any]:
    """
    Background worker loop that processes queued messages.
    Strictly respects configured delay between consecutive dispatches.
    """
    sms_cfg = config.get("bestsmsbulk", {})
    endpoint = sms_cfg.get("api_endpoint", "https://www.bestsmsbulk.com/bestsmsbulkapi/whatsappmsging/sendMessage.php")
    api_key = sms_cfg.get("api_key", "teshrij")
    api_secret = sms_cfg.get("api_secret", "Teshrij123")

    sender_cfg = config.get("sender", {})
    send_delay = float(sender_cfg.get("send_delay", 1.5))
    max_retries = int(sender_cfg.get("max_retries", 3))

    stats = {
        "processed": 0,
        "sent": 0,
        "failed": 0
    }

    # Recover any items left in SENDING status from a previously crashed/interrupted worker
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute("UPDATE send_queue SET status = 'QUEUED' WHERE status = 'SENDING'")
    conn.commit()

    query = "SELECT id, draft_id, contact, message, attempts FROM send_queue WHERE status = 'QUEUED' ORDER BY id ASC"
    if limit:
        query += f" LIMIT {int(limit)}"
    cursor.execute(query)
    queue_items = [dict(r) for r in cursor.fetchall()]
    conn.close()

    last_send_time: Optional[float] = None
    for item in queue_items:
        if stop_event and stop_event.is_set():
            break

        queue_id = item["id"]
        draft_id = item["draft_id"]
        contact = item["contact"]
        msg = item["message"]
        attempts = item.get("attempts", 0) + 1

        # GUARD_15 dispatch-time recheck: contact permission & unchanged conversation
        conn = get_db_connection(db_path)
        cur = conn.cursor()
        cur.execute("SELECT status FROM contacts WHERE contact = ?", (contact,))
        c_row = cur.fetchone()
        if c_row and (c_row["status"] or "").upper() in ("OPT_OUT", "SUPPRESSED", "BLOCKED", "INACTIVE"):
            cur.execute("UPDATE send_queue SET status = 'FAILED', error_message = 'Contact opted out before dispatch (GUARD_15)' WHERE id = ?", (queue_id,))
            conn.commit()
            conn.close()
            stats["failed"] += 1
            if progress_callback:
                progress_callback(f"CANCELLED dispatch to {contact}: contact opted out or suppressed (GUARD_15)")
            continue

        cur.execute("SELECT MAX(timestamp) FROM chats WHERE contact = ? AND UPPER(direction) = 'INCOMING'", (contact,))
        last_inc = cur.fetchone()
        if last_inc and last_inc[0]:
            cur.execute("SELECT scheduled_at FROM send_queue WHERE id = ?", (queue_id,))
            sq_row = cur.fetchone()
            if sq_row and sq_row[0] and str(last_inc[0]) > str(sq_row[0]):
                cur.execute("UPDATE send_queue SET status = 'FAILED', error_message = 'New customer message arrived while queued (GUARD_15)' WHERE id = ?", (queue_id,))
                conn.commit()
                conn.close()
                stats["failed"] += 1
                if progress_callback:
                    progress_callback(f"CANCELLED dispatch to {contact}: new customer message arrived while queued (GUARD_15)")
                continue
        conn.close()

        stats["processed"] += 1

        if dry_run:
            if progress_callback:
                progress_callback(f"[DRY RUN] Would send to {contact}: {msg[:30]}...")
            stats["sent"] += 1
            continue

        # Strictly maintain configured delay between consecutive message dispatches
        if last_send_time is not None and send_delay > 0:
            elapsed = time.time() - last_send_time
            if elapsed < send_delay:
                time.sleep(send_delay - elapsed)

        # Mark as SENDING
        conn = get_db_connection(db_path)
        cur = conn.cursor()
        cur.execute("UPDATE send_queue SET status = 'SENDING', attempts = ? WHERE id = ?", (attempts, queue_id))
        conn.commit()
        conn.close()

        try:
            res = send_whatsapp_message(
                destination=contact,
                message=msg,
                api_endpoint=endpoint,
                api_key=api_key,
                api_secret=api_secret
            )

            success = res.get("success", False)
            api_res_str = json.dumps(res)

            conn = get_db_connection(db_path)
            cur = conn.cursor()

            if success:
                stats["sent"] += 1
                cur.execute("""
                UPDATE send_queue
                SET status = 'SENT', sent_at = CURRENT_TIMESTAMP, api_response = ?
                WHERE id = ?
                """, (api_res_str, queue_id))

                if draft_id:
                    cur.execute("UPDATE followup_drafts SET status = 'SENT', updated_at = CURRENT_TIMESTAMP WHERE id = ?", (draft_id,))
                
                if progress_callback:
                    progress_callback(f"SENT to {contact} successfully.")
            else:
                err_msg = res.get("message") or res.get("error") or "Unknown error"
                stats["failed"] += 1
                
                new_status = "FAILED" if attempts >= max_retries else "QUEUED"
                cur.execute("""
                UPDATE send_queue
                SET status = ?, error_message = ?, api_response = ?
                WHERE id = ?
                """, (new_status, err_msg, api_res_str, queue_id))

                if draft_id and new_status == "FAILED":
                    cur.execute("UPDATE followup_drafts SET status = 'FAILED', updated_at = CURRENT_TIMESTAMP WHERE id = ?", (draft_id,))

                if progress_callback:
                    progress_callback(f"FAILED sending to {contact}: {err_msg}")

            conn.commit()
            conn.close()
        except Exception as ex:
            stats["failed"] += 1
            err_msg = f"Unexpected dispatch error: {str(ex)}"
            new_status = "FAILED" if attempts >= max_retries else "QUEUED"
            try:
                conn = get_db_connection(db_path)
                cur = conn.cursor()
                cur.execute("""
                UPDATE send_queue
                SET status = ?, error_message = ?
                WHERE id = ?
                """, (new_status, err_msg, queue_id))
                if draft_id and new_status == "FAILED":
                    cur.execute("UPDATE followup_drafts SET status = 'FAILED', updated_at = CURRENT_TIMESTAMP WHERE id = ?", (draft_id,))
                conn.commit()
                conn.close()
            except Exception:
                pass
            if progress_callback:
                progress_callback(f"FAILED sending to {contact}: {err_msg}")
        finally:
            last_send_time = time.time()

    return stats


def auto_dispatch_unreviewed(
    config: Dict[str, Any],
    limit: Optional[int] = None,
    dry_run: bool = False,
    progress_callback: Optional[Any] = None,
    db_path: str = DEFAULT_DB_PATH
) -> Dict[str, Any]:
    """
    Automatic Unreviewed Mode:
    Takes all 'PENDING' drafts, queues them automatically, and executes the send worker.
    """
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    query = """
    SELECT id, contact, drafted_msg
    FROM followup_drafts
    WHERE status = 'PENDING' AND (decision IS NULL OR decision = 'SEND')
      AND drafted_msg IS NOT NULL AND TRIM(drafted_msg) != ''
    ORDER BY id ASC
    """
    if limit:
        query += f" LIMIT {int(limit)}"
    cursor.execute(query)
    pending_drafts = [dict(r) for r in cursor.fetchall()]
    conn.close()

    queued_count = 0
    for draft in pending_drafts:
        # Check if already queued
        conn = get_db_connection(db_path)
        cur = conn.cursor()
        cur.execute("SELECT id FROM send_queue WHERE draft_id = ? AND status IN ('QUEUED', 'SENDING', 'SENT')", (draft["id"],))
        existing = cur.fetchone()
        conn.close()
        if not existing:
            qid = queue_draft_for_sending(draft["id"], db_path=db_path)
            if qid:
                conn = get_db_connection(db_path)
                cur = conn.cursor()
                cur.execute("UPDATE followup_drafts SET status = 'APPROVED' WHERE id = ?", (draft["id"],))
                conn.commit()
                conn.close()
                queued_count += 1

    if progress_callback:
        progress_callback(f"Queued {queued_count} unreviewed drafts for dispatch.")

    # Process the queue
    return process_send_queue(
        config=config,
        dry_run=dry_run,
        progress_callback=progress_callback,
        db_path=db_path
    )
