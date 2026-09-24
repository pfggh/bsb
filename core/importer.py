"""
Chat history importer for BestSMSBulk CSV exports.
Handles phone normalization, duplicate detection, and chronological sorting.
"""

import os
import csv
import re
import sqlite3
from typing import Dict, Any, Tuple, List, Optional
from datetime import datetime
from core.db import get_db_connection, DEFAULT_DB_PATH


def normalize_phone(phone_str: Any) -> str:
    """
    Cleans and normalizes phone numbers into digits-only standard international destination format.
    Accurately supports Lebanese numbers (03, 70, 71, 76, 78, 79, 80, 81, 7xxxxxxx, 8xxxxxxx)
    and international formats. Rejects social handles (e.g. ig_...).
    """
    if not phone_str:
        return ""

    raw = str(phone_str).strip()
    # If the contact is an Instagram/social username (e.g. ig_123456), it's not a phone number
    if raw.lower().startswith("ig_"):
        return ""

    digits = re.sub(r"\D", "", raw)
    if not digits:
        return ""

    # Strip leading international double zero (e.g. 00961... -> 961...)
    if digits.startswith("00"):
        digits = digits[2:]
        if not digits:
            return ""

    # Check if number starts with 961
    if digits.startswith("961"):
        rest = digits[3:]
        # If followed by 03: 961 03xxxxxx -> 961 3xxxxxx
        if rest.startswith("03") and len(rest) == 8:
            return "961" + rest[1:]
        return digits

    # Lebanese 8 digits starting with 03: 03xxxxxx -> 9613xxxxxx
    if len(digits) == 8 and digits.startswith("03"):
        return "961" + digits[1:]

    # Lebanese 7 digits starting with 3 (e.g. 3xxxxxx) -> 9613xxxxxx
    if len(digits) == 7 and digits.startswith("3"):
        return "961" + digits

    # Lebanese 7 digits starting with 7 or 8 (e.g. 70xxxxx -> 96170xxxxx)
    if len(digits) == 7 and (digits.startswith("7") or digits.startswith("8")):
        return "961" + digits

    # Lebanese 8 digits starting with 7 or 8: 7xxxxxxx, 8xxxxxxx -> 9617... / 9618...
    if len(digits) == 8 and (digits.startswith("7") or digits.startswith("8")):
        return "961" + digits

    # Other international numbers (digits only)
    return digits


def parse_timestamp(date_str: str, time_str: str) -> str:
    """Combines Date and Time into a standard ISO format string: YYYY-MM-DD HH:MM:SS."""
    date_clean = (date_str or "").strip()
    time_clean = (time_str or "").strip()
    if not date_clean:
        try:
            import zoneinfo
            return datetime.now(zoneinfo.ZoneInfo("Asia/Beirut")).strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # If date_clean already includes time (e.g. '2026-09-10 10:00:00' or with 'T')
    if " " in date_clean or "T" in date_clean:
        combined = date_clean.replace("T", " ")
    else:
        if not time_clean:
            time_clean = "00:00:00"
        combined = f"{date_clean} {time_clean}"

    # Normalize to YYYY-MM-DD HH:MM:SS if parseable
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
        "%d/%m/%Y",
        "%Y/%m/%d %H:%M:%S",
        "%Y/%m/%d %H:%M",
        "%Y/%m/%d",
        "%m/%d/%Y %H:%M:%S",
        "%m/%d/%Y %H:%M",
        "%m/%d/%Y",
    ):
        try:
            return datetime.strptime(combined, fmt).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(combined).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return combined


def import_csv_chats(csv_path: str, db_path: str = DEFAULT_DB_PATH) -> Dict[str, Any]:
    """
    Imports messages from BestSMSBulk CSV export into SQLite database.
    Performs deduplication and updates contact summaries.
    Returns summary stats dict: {"total_rows": int, "inserted": int, "duplicates": int, "contacts_updated": int}
    """
    if not os.path.exists(csv_path):
        raise FileNotFoundError(f"CSV file not found: {csv_path}")

    conn = get_db_connection(db_path)
    cursor = conn.cursor()

    stats = {
        "total_rows": 0,
        "inserted": 0,
        "duplicates": 0,
        "contacts_updated": 0,
        "errors": 0
    }

    BATCH_SIZE = 5000

    def flush_chat_batch(batch: List[Tuple]):
        if not batch:
            return
        before_changes = conn.total_changes
        try:
            cursor.executemany("""
            INSERT INTO chats (
                chat_id, contact, profile_name, channel, direction,
                message, extracted_reply, reply_to, status,
                media_type, media_url, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(chat_id, contact, timestamp) DO NOTHING
            """, batch)
            batch_inserted = conn.total_changes - before_changes
            stats["inserted"] += batch_inserted
            stats["duplicates"] += (len(batch) - batch_inserted)
        except Exception as e:
            stats["errors"] += len(batch)

    # BestSMSBulk CSV headers format:
    # "Chat ID",Date,Time,Contact,"Profile Name",Channel,Direction,"Raw Message","Extracted Reply","Reply To",Status,"Media Type","Media URL"
    with open(csv_path, "r", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f)
        header_map = {col.lower().replace('"', '').strip(): col for col in (reader.fieldnames or [])}
        
        contact_col = header_map.get("contact")
        if not contact_col:
            raise ValueError(f"CSV is missing 'Contact' column. Found: {reader.fieldnames}")

        chats_to_insert = []
        contacts_map: Dict[str, Dict[str, Any]] = {}

        for row in reader:
            stats["total_rows"] += 1
            
            raw_contact = row.get(header_map.get("contact", "Contact")) or ""
            contact = normalize_phone(raw_contact)
            if not contact:
                continue

            chat_id = (row.get(header_map.get("chat id", "Chat ID")) or "").strip()
            date_val = (row.get(header_map.get("date", "Date")) or "").strip()
            time_val = (row.get(header_map.get("time", "Time")) or "").strip()
            timestamp = parse_timestamp(date_val, time_val)

            profile_name = (row.get(header_map.get("profile name", "Profile Name")) or "").strip()
            channel = (row.get(header_map.get("channel", "Channel")) or "").strip()
            direction = (row.get(header_map.get("direction", "Direction")) or "").strip()
            raw_message = (row.get(header_map.get("raw message", "Raw Message")) or "")
            extracted_reply = (row.get(header_map.get("extracted reply", "Extracted Reply")) or "")
            reply_to = (row.get(header_map.get("reply to", "Reply To")) or "")
            status = (row.get(header_map.get("status", "Status")) or "").strip()
            media_type = (row.get(header_map.get("media type", "Media Type")) or "").strip()
            media_url = (row.get(header_map.get("media url", "Media URL")) or "").strip()

            chats_to_insert.append((
                chat_id, contact, profile_name, channel, direction,
                raw_message, extracted_reply, reply_to, status,
                media_type, media_url, timestamp
            ))

            if len(chats_to_insert) >= BATCH_SIZE:
                flush_chat_batch(chats_to_insert)
                chats_to_insert.clear()

            if contact not in contacts_map:
                contacts_map[contact] = {
                    "profile_name": profile_name,
                    "last_interaction": timestamp,
                    "count": 1
                }
            else:
                contacts_map[contact]["count"] += 1
                if profile_name and not contacts_map[contact]["profile_name"]:
                    contacts_map[contact]["profile_name"] = profile_name
                if timestamp > contacts_map[contact]["last_interaction"]:
                    contacts_map[contact]["last_interaction"] = timestamp

        # Flush any remaining chats
        if chats_to_insert:
            flush_chat_batch(chats_to_insert)
            chats_to_insert.clear()

        # Batch upsert contacts summary
        if contacts_map:
            contact_rows = [
                (contact, data["profile_name"], data["last_interaction"])
                for contact, data in contacts_map.items()
            ]
            for i in range(0, len(contact_rows), BATCH_SIZE):
                c_batch = contact_rows[i:i + BATCH_SIZE]
                cursor.executemany("""
                INSERT INTO contacts (contact, profile_name, last_interaction, total_messages)
                VALUES (?, ?, ?, 0)
                ON CONFLICT(contact) DO UPDATE SET
                    profile_name = CASE WHEN excluded.profile_name != '' THEN excluded.profile_name ELSE contacts.profile_name END,
                    last_interaction = CASE WHEN excluded.last_interaction > contacts.last_interaction THEN excluded.last_interaction ELSE contacts.last_interaction END,
                    updated_at = CURRENT_TIMESTAMP
                """, c_batch)

            # Recalculate total_messages for imported contacts in batch
            contact_keys = [(c,) for c in contacts_map.keys()]
            for i in range(0, len(contact_keys), BATCH_SIZE):
                k_batch = contact_keys[i:i + BATCH_SIZE]
                cursor.executemany("""
                UPDATE contacts
                SET total_messages = (SELECT COUNT(*) FROM chats WHERE chats.contact = contacts.contact)
                WHERE contact = ?
                """, k_batch)

            stats["contacts_updated"] = len(contacts_map)

        conn.commit()
        conn.close()

    return stats


def get_contact_chat_history(contact: str, db_path: str = DEFAULT_DB_PATH, limit: int = 50) -> List[Dict[str, Any]]:
    """Retrieves chronological chat messages for a given contact."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute("""
    SELECT id, chat_id, contact, profile_name, channel, direction,
           message, extracted_reply, reply_to, status, media_type, media_url, timestamp
    FROM chats
    WHERE contact = ?
    ORDER BY timestamp ASC
    LIMIT ?
    """, (contact, limit))
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]
