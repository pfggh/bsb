#!/usr/bin/env python3
"""
core/bsb_sync.py - Continuous BestSMSBulk to Supabase Sync Ingestor
Uses the verified human-check bypass to export chats and stream directly
into PostgreSQL bsb_messages table.
"""

import os
import sys
import time
import io
import csv
import re
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional
import requests
import psycopg2
from psycopg2.extras import execute_values, RealDictCursor

BASE_URL = "https://www.bestsmsbulk.com/pro-livechat"
DEFAULT_AGENT_KEY = "0670126f7e99ae241c84d3a6d32e84c2"

DB_CONFIG = {
    "dbname": "postgres",
    "user": "postgres.kfgswynickhywzhneltu",
    "password": "raise unable duck fanatical arrest yard maid stunner truffle",
    "host": "aws-0-eu-central-1.pooler.supabase.com",
    "port": 5432,
    "connect_timeout": 15
}


def get_db():
    addrs = ["18.198.145.223", "52.59.152.35", "18.198.30.239", ""]
    last_err = None
    for addr in addrs:
        try:
            params = dict(DB_CONFIG)
            if addr:
                params["hostaddr"] = addr
            conn = psycopg2.connect(**params)
            conn.autocommit = True
            return conn
        except Exception as e:
            last_err = e
            continue
    raise last_err or psycopg2.OperationalError("Unable to connect to Supabase pooler.")


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


def get_authenticated_session(agent_key: str = DEFAULT_AGENT_KEY) -> Optional[requests.Session]:
    """Completes BSB Human Check challenge and authenticates agent session."""
    s = requests.Session()
    headers = {
        "User-Agent": "Mozilla/5.0 (X-UA-Compatible; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        "Origin": "https://www.bestsmsbulk.com",
        "Referer": f"{BASE_URL}/index.html"
    }

    try:
        # Step 1: Start human-check challenge
        r1 = s.post(f"{BASE_URL}/api/login-human-check.php", data={"action": "start"}, headers=headers, timeout=15)
        nonce = r1.json().get("nonce")
        if not nonce:
            print(f"[BSB SYNC] Failed to get human-check nonce: {r1.text[:150]}")
            return None

        # Step 2: Hold for timing threshold
        time.sleep(3.5)

        # Step 3: Finish human-check challenge
        r2 = s.post(f"{BASE_URL}/api/login-human-check.php", data={"action": "finish", "nonce": nonce}, headers=headers, timeout=15)
        human_token = r2.json().get("human_token")
        if not human_token:
            print(f"[BSB SYNC] Failed to get human_token: {r2.text[:150]}")
            return None

        # Step 4: Validate agent key
        r3 = s.post(f"{BASE_URL}/api/validate-key.php", data={
            "secret_key": agent_key,
            "human_token": human_token,
            "force_login": "1"
        }, headers=headers, timeout=15)
        login_res = r3.json()

        if login_res.get("success"):
            return s
        else:
            print(f"[BSB SYNC] Validation error: {login_res.get('message')}")
            return None
    except Exception as e:
        print(f"[BSB SYNC] Authentication exception: {e}")
        return None


def sync_chats_to_db(days_back: int = 2) -> Dict[str, Any]:
    """Downloads recent CSV exports from BSB and upserts into bsb_messages."""
    session = get_authenticated_session()
    if not session:
        return {"success": False, "error": "Authentication failed"}

    headers = {
        "User-Agent": "Mozilla/5.0 (X-UA-Compatible; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        "Origin": "https://www.bestsmsbulk.com",
        "Referer": f"{BASE_URL}/users.html"
    }

    now_utc = datetime.now(timezone.utc)
    dates_to_sync = [(now_utc - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(days_back, -1, -1)]

    total_records = 0
    records = []

    for d in dates_to_sync:
        try:
            r = session.post(f"{BASE_URL}/php/export-chats.php", data={
                "action": "export_chats",
                "start_date": d,
                "end_date": d,
                "format": "csv"
            }, headers=headers, timeout=30)

            if r.status_code != 200 or len(r.text) < 50:
                continue

            reader = csv.reader(io.StringIO(r.text))
            header = None
            for row in reader:
                if not header:
                    header = [h.strip().replace("\ufeff", "").replace('"', "") for h in row]
                    continue
                if len(row) >= 12:
                    chat_id = row[0].strip()
                    date_str = row[1].strip()
                    time_str = row[2].strip()
                    contact = normalize_phone(row[3].strip())
                    profile_name = row[4].strip() if len(row) > 4 else None
                    channel = row[5].strip() if len(row) > 5 else None
                    direction = row[6].strip() if len(row) > 6 else "Incoming"
                    raw_msg = row[7] if len(row) > 7 else ""
                    extracted = row[8] if len(row) > 8 else None
                    sent_by = row[9] if len(row) > 9 else None
                    reply_to = row[10] if len(row) > 10 else None
                    status = row[11] if len(row) > 11 else None
                    media_type = row[12] if len(row) > 12 else None
                    media_url = row[13] if len(row) > 13 else None

                    if not contact or not chat_id:
                        continue

                    try:
                        ts_str = f"{date_str} {time_str}"
                        dt = datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                    except Exception:
                        continue

                    has_tracking = "ad_id" in raw_msg.lower() or "meta" in raw_msg.lower()
                    records.append((
                        chat_id, contact, profile_name, channel, direction, raw_msg,
                        extracted, sent_by, reply_to, status, media_type, media_url,
                        dt, has_tracking
                    ))
        except Exception as e:
            print(f"[BSB SYNC] Export error for {d}: {e}")

    if not records:
        return {"success": True, "inserted": 0, "total": 0}

    # Upsert into PostgreSQL
    try:
        conn = get_db()
        cur = conn.cursor()
        query = """
        INSERT INTO public.bsb_messages (
            chat_id, contact, profile_name, channel, direction, message,
            extracted_reply, sent_by, reply_to, status, media_type, media_url,
            timestamp, has_tracking
        ) VALUES %s
        ON CONFLICT (chat_id) DO NOTHING;
        """
        execute_values(cur, query, records, page_size=500)

        # Log to bsb_sync_logs
        cur.execute("""
            INSERT INTO public.bsb_sync_logs (
                status, start_date, end_date, files_processed, total_rows, inserted, error_message
            ) VALUES (%s, %s, %s, %s, %s, %s, %s);
        """, ("success", dates_to_sync[0], dates_to_sync[-1], len(dates_to_sync), len(records), len(records), None))

        cur.close()
        conn.close()
        print(f"[BSB SYNC] Successfully synced {len(records)} messages across {len(dates_to_sync)} day(s).")
        return {"success": True, "total": len(records)}
    except Exception as e:
        print(f"[BSB SYNC] Ingestion error: {e}")
        return {"success": False, "error": str(e)}


if __name__ == "__main__":
    sync_chats_to_db(days_back=2)
