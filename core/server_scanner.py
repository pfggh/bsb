#!/usr/bin/env python3
"""
core/server_scanner.py - Server-Side AI Follow-up Scanner for Teshrij Suite
Exact same backend logic as Fady_bot/core/analyzer.py — ported to Supabase/PostgreSQL.
Enforces 24h window, full cancellation guards, dispatch gate, RAG, retry logic.
"""

import os
import sys
import json
import time
import re
import threading
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed
import psycopg2
from psycopg2.extras import RealDictCursor
from openai import OpenAI

# ============================================================================
# DB Connection
# ============================================================================

DB_URL = "postgresql://postgres.kfgswynickhywzhneltu:raise%20unable%20duck%20fanatical%20arrest%20yard%20maid%20stunner%20truffle@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POLICY_PATH = os.path.join(BASE_DIR, "feedback_learning_v2", "runtime_policy.txt")
PROMPT_PATH = os.path.join(BASE_DIR, "prompts", "system_prompt.txt")


def connect_db():
    addrs = ["18.198.145.223", "52.59.152.35", "18.198.30.239", ""]
    last_err = None
    for addr in addrs:
        try:
            params = {
                "dbname": "postgres",
                "user": "postgres.kfgswynickhywzhneltu",
                "password": "raise unable duck fanatical arrest yard maid stunner truffle",
                "host": "aws-0-eu-central-1.pooler.supabase.com",
                "port": 5432,
                "connect_timeout": 8
            }
            if addr:
                params["hostaddr"] = addr
            conn = psycopg2.connect(**params)
            conn.autocommit = True
            return conn
        except Exception as e:
            last_err = e
            continue
    raise last_err or psycopg2.OperationalError("Unable to connect to Supabase pooler.")


def get_db():
    return connect_db()


# ============================================================================
# Config / OpenAI Client (reads from DB like Fady_bot reads config.yaml)
# ============================================================================

def get_openai_client_and_model() -> Tuple[OpenAI, str, float]:
    """Reads model config from followup_config DB table (equivalent to Fady_bot config.yaml)."""
    api_key = os.environ.get("OPENAI_API_KEY")
    chat_model = "gpt-5.6-terra"
    temperature = 1.0
    conn = get_db()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("SELECT value FROM followup_config WHERE key = 'openai'")
    row = cur.fetchone()
    cur.close()
    conn.close()
    if row and row.get("value"):
        if not api_key:
            api_key = row["value"].get("api_key")
        chat_model = row["value"].get("chat_model") or "gpt-5.6-terra"
        temperature = float(row["value"].get("temperature") or 1.0)
    if not api_key:
        raise ValueError("OPENAI_API_KEY not configured in environment or followup_config.")
    return OpenAI(api_key=api_key), chat_model, temperature


# ============================================================================
# System Prompt Loading (exact port of Fady_bot load_system_prompt)
# ============================================================================

def load_system_prompt() -> str:
    """
    Loads policy + base prompt from DB (with local file fallback),
    then appends the strict JSON response contract.
    Exact port of Fady_bot analyzer.py load_system_prompt().
    """
    policy = ""
    prompt_base = ""

    # Try loading live from Supabase followup_config first
    try:
        conn = get_db()
        cur = conn.cursor(cursor_factory=RealDictCursor)
        cur.execute("SELECT key, value FROM followup_config WHERE key IN ('system_prompt', 'runtime_policy')")
        rows = cur.fetchall()
        cur.close()
        conn.close()
        for r in rows:
            if r["key"] == "system_prompt" and r.get("value"):
                prompt_base = r["value"].get("prompt") or ""
            elif r["key"] == "runtime_policy" and r.get("value"):
                policy = r["value"].get("policy") or ""
    except Exception as e:
        print(f"[WARN] Error fetching prompt/policy from followup_config: {e}")

    # Fallback to local files if not in database
    if not policy and os.path.exists(POLICY_PATH):
        with open(POLICY_PATH, "r", encoding="utf-8") as f:
            policy = f.read().strip()

    if not prompt_base and os.path.exists(PROMPT_PATH):
        with open(PROMPT_PATH, "r", encoding="utf-8") as f:
            prompt_base = f.read().strip()

    prompt_parts = []
    if policy:
        prompt_parts.append(policy)
    if prompt_base:
        prompt_parts.append(prompt_base)

    combined = "\n\n".join(prompt_parts).strip()
    if not combined:
        combined = "You are an intelligent WhatsApp follow-up assistant. Respond strictly in valid JSON format."

    # Append strict JSON contract (same as Fady_bot)
    json_contract = (
        "\n\n### RESPONSE CONTRACT (OUTPUT JSON SCHEMA):\n"
        "You must respond strictly with a valid JSON object matching this schema:\n"
        "{\n"
        '  "decision": "SEND" | "SKIP",\n'
        '  "category": "sales" | "support" | "guardrails" | "style",\n'
        '  "message": "string" or null,\n'
        '  "rule_ids": ["RULE_ID_1", "RULE_ID_2"],\n'
        '  "internal_reason": "Detailed explanation of decision"\n'
        "}\n\n"
        "RULES FOR MESSAGE OUTPUT:\n"
        "- Only 'SEND' may contain a message. For 'SKIP', 'message' MUST be null.\n"
        "- Always follow up (SEND) with customers who received ChatGPT/Anghami pricing or details without purchasing, unless they opted out or already received the final followup ('Final Followup; ...').\n"
        "- Messaging is restricted to WhatsApp's 24-hour service window. If problem confirmed resolved, or customer declined/opted out, choose 'SKIP'.\n"
        "- Keep message short (1-2 sentences), natural Lebanese Arabizi or clean English, at most 1 question mark.\n"
        "- NEVER include URLs, links, email addresses, or unreplaced placeholder tokens like {price} or {plan}.\n"
        "- Never make unauthorized operational promises ('I will activate/fix/check')."
    )

    if "output json schema" not in combined.lower():
        combined += json_contract
    elif "json" not in combined.lower():
        combined += "\n\nRespond strictly with a valid JSON object."

    return combined


# ============================================================================
# Timestamp / 24h Window Logic (exact port of Fady_bot)
# ============================================================================

def parse_timestamp(ts_val: Any) -> Optional[datetime]:
    """Parses various datetime formats returned by Supabase/psycopg2."""
    if not ts_val:
        return None
    if isinstance(ts_val, datetime):
        return ts_val
    ts_str = str(ts_val).strip()
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%S.%f",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S.%f%z",
        "%Y-%m-%d",
    ):
        try:
            return datetime.strptime(ts_str, fmt)
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(ts_str)
    except Exception:
        return None


def normalize_dt(dt: datetime) -> datetime:
    """Strip timezone info and normalize to Beirut local (UTC+3)."""
    if dt is None:
        return None
    try:
        import zoneinfo
        beirut_tz = zoneinfo.ZoneInfo("Asia/Beirut")
        if dt.tzinfo is not None:
            return dt.astimezone(beirut_tz).replace(tzinfo=None)
    except Exception:
        if dt.tzinfo is not None:
            return dt.replace(tzinfo=None)
    return dt


def get_reference_now() -> datetime:
    """Returns current Beirut time as naive datetime."""
    try:
        import zoneinfo
        return datetime.now(zoneinfo.ZoneInfo("Asia/Beirut")).replace(tzinfo=None)
    except Exception:
        return datetime.now()


def check_24h_window_eligibility(
    messages: List[Dict[str, Any]],
    ref_dt: Optional[datetime] = None,
    min_hours: float = 2.0,
    max_hours: float = 24.0
) -> Tuple[bool, str, str]:
    """
    Exact port of Fady_bot check_24h_window_eligibility().
    Returns (is_eligible, ineligibility_reason, cancel_reason).
    """
    if not messages:
        return False, "No chat messages found for contact.", "No chat messages found for contact."

    if ref_dt is None:
        ref_dt = get_reference_now()
    ref_dt = normalize_dt(ref_dt)

    # Verify customer last INCOMING message is within 24h window
    incoming_msgs = [m for m in messages if (m.get("direction") or "").strip().upper() == "INCOMING"]
    if incoming_msgs:
        last_incoming = incoming_msgs[-1]
        inc_dt = parse_timestamp(last_incoming.get("timestamp"))
        if inc_dt:
            inc_dt = normalize_dt(inc_dt)
            inc_hours = (ref_dt - inc_dt).total_seconds() / 3600.0
            if inc_hours > max_hours or inc_hours < -24.0:
                return (
                    False,
                    "Customer last message outside 24h window or already responded",
                    "Customer last message outside 24h window or already responded: 24h window expired"
                )
    else:
        return (
            False,
            "Customer last message outside 24h window or already responded",
            "Customer last message outside 24h window or already responded: no incoming customer messages"
        )

    # Check last message timestamp (any direction)
    last_msg = messages[-1]
    ts_val = last_msg.get("timestamp")
    msg_dt = parse_timestamp(ts_val)
    if not msg_dt:
        return (
            False,
            "Customer last message outside 24h window or already responded",
            "Customer last message outside 24h window or already responded: invalid timestamp"
        )

    msg_dt = normalize_dt(msg_dt)
    hours_diff = (ref_dt - msg_dt).total_seconds() / 3600.0

    if hours_diff > max_hours or hours_diff < -24.0:
        return (
            False,
            "Customer last message outside 24h window or already responded",
            "Customer last message outside 24h window or already responded: 24h window expired"
        )

    if hours_diff < min_hours:
        return (
            False,
            f"Chat is too recent (< {min_hours:g}h old) to follow up",
            f"Chat is too recent (< {min_hours:g}h old, last message was {hours_diff:.1f}h ago)"
        )

    return True, "", ""


# ============================================================================
# Cancellation Guards (exact port of Fady_bot check_canonical_cancellation_guards)
# ============================================================================

def check_canonical_cancellation_guards(
    messages: List[Dict[str, Any]],
    proposed_message: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """
    Exact port of Fady_bot check_canonical_cancellation_guards().
    Evaluates conversation against definitive cancellation rules.
    Returns a SKIP payload if a guard triggers, else None.
    """
    if not messages:
        return None

    # Find the latest customer (Incoming) message
    last_incoming = None
    for m in reversed(messages):
        if (m.get("direction") or "").upper() == "INCOMING":
            last_incoming = m
            break

    if not last_incoming:
        return None

    last_in_text = (last_incoming.get("message") or "").strip().lower()

    # 1. GUARD_04: Untranscribed Voice Message
    if "voice message" in last_in_text or "🎤" in last_in_text or "[audio]" in last_in_text:
        return {
            "decision": "SKIP",
            "category": "guardrails",
            "rule_ids": ["GUARD_04"],
            "cancel_reason": "GUARD_04: Untranscribed customer voice message (do not guess intent)",
            "internal_reason": "GUARD_04: Voice note as latest message requires manual review or pause.",
            "message": None
        }

    # 2. SALES_10 / SALES_11: Customer explicit refusal or soft Lebanese deferral
    decline_patterns = [
        "bredelkon khabar", "breddelkoun khabar", "bredelkon", "breddelkoun",
        "mish hala2", "not at the moment", "ma bade", "no thanks", "anyway thanks",
        "just checking", "shway w bshuf", "3am bes2al bas", "i will check and let you know",
        "i ll check and let you know", "not interested", "dont want", "no need", "machi merci"
    ]
    if any(p in last_in_text for p in decline_patterns):
        return {
            "decision": "SKIP",
            "category": "sales",
            "rule_ids": ["SALES_10", "SALES_11"],
            "cancel_reason": "SALES_10/SALES_11: Customer soft deferral or refusal ends proactive outreach",
            "internal_reason": "Customer explicitly deferred or declined further outreach.",
            "message": None
        }

    # 3. GUARD_03: Payment reported or transfer proof sent
    payment_patterns = [
        "paid", "w2w", "whish transfer", "transferred", "sent the payment",
        "sent payment", "transfer done", "check the amount", "wselet l payment", "dafa3et",
        "hawal", "7awal", "ba3at", "b3at", "sent it"
    ]
    if any(p in last_in_text for p in payment_patterns):
        return {
            "decision": "SKIP",
            "category": "guardrails",
            "rule_ids": ["GUARD_03"],
            "cancel_reason": "GUARD_03: Payment reported by customer",
            "internal_reason": "Customer reported payment; fulfillment/verification owned by operator.",
            "message": None
        }

    # 4. SALES_13: Final Followup already delivered and no subsequent customer reopening
    has_final_outgoing = False
    final_msg_idx = -1
    for idx, m in enumerate(messages):
        if (m.get("direction") or "").upper() == "OUTGOING":
            otxt = (m.get("message") or "").strip().lower()
            if otxt.startswith("final followup;") or "(last followup)" in otxt or "(final followup)" in otxt or otxt == "last followup":
                has_final_outgoing = True
                final_msg_idx = idx

    if has_final_outgoing:
        subsequent_customer_msgs = [m for m in messages[final_msg_idx + 1:] if (m.get("direction") or "").upper() == "INCOMING"]
        if not subsequent_customer_msgs:
            return {
                "decision": "SKIP",
                "category": "sales",
                "rule_ids": ["SALES_13"],
                "cancel_reason": "SALES_13: A final sales follow-up was already sent and remained unanswered",
                "internal_reason": "Final follow-up already delivered; sequence exhausted.",
                "message": None
            }
        else:
            last_sub = subsequent_customer_msgs[-1]
            sub_txt = (last_sub.get("message") or "").strip().lower()
            if any(t in sub_txt for t in ["thank", "merci", "thx", "ok", "machi", "done", "👍", "❤️", "🙏🏻"]) and \
               not any(q in sub_txt for q in ["?", "price", "how much", "baddak", "bade", "wanna buy"]):
                return {
                    "decision": "SKIP",
                    "category": "sales",
                    "rule_ids": ["SALES_13"],
                    "cancel_reason": "SALES_13: Polite closure following delivered final follow-up",
                    "internal_reason": "Customer acknowledged final follow-up with courtesy; sequence finished.",
                    "message": None
                }

    # 5. SUPPORT_06: Implicit resolution (Remedy delivered + customer thanks/reaction or business welcome)
    remedy_idx = -1
    for i, m in enumerate(messages):
        if (m.get("direction") or "").upper() == "OUTGOING":
            otxt = (m.get("message") or "").strip().lower()
            if ("teshrij.xyz" in otxt or "tv.ostories.me" in otxt or "email:" in otxt or
                    "password:" in otxt or "workspace" in otxt or "select mavos" in otxt or
                    "anghami.com" in otxt or "try now" in otxt or "jarrib" in otxt or
                    "jarreb" in otxt or "check now" in otxt):
                remedy_idx = i

    if remedy_idx != -1:
        subsequent = messages[remedy_idx + 1:]
        has_subsequent_complaint = False
        has_thanks_or_reaction = False
        for sub in subsequent:
            stxt = (sub.get("message") or "").strip().lower()
            s_dir = (sub.get("direction") or "").upper()
            if s_dir == "INCOMING":
                if any(err in stxt for err in ["not working", "ma am ymche", "ma 3am", "error", "full hyda", "ma zaba", "problem"]):
                    has_subsequent_complaint = True
                elif any(thx in stxt for thx in ["thank", "merci", "thx", "thanks", "done", "yes", "👍", "❤️", "🙏🏻", "ye", "eh"]):
                    has_thanks_or_reaction = True
            elif s_dir == "OUTGOING":
                if any(w in stxt for w in ["welcomee", "ur welcome", "you're welcome"]):
                    has_thanks_or_reaction = True

        if has_thanks_or_reaction and not has_subsequent_complaint:
            return {
                "decision": "SKIP",
                "category": "support",
                "rule_ids": ["SUPPORT_06"],
                "cancel_reason": "SUPPORT_06: Implicit support resolution (customer confirmed via thanks/reaction)",
                "internal_reason": "Support remedy implicitly confirmed working; outcome checks cancelled.",
                "message": None
            }

    # 6. SUPPORT_12: Anghami does not use login credentials
    if proposed_message:
        all_conv_text = " ".join((m.get("message") or "") for m in messages).lower()
        prop_lower = proposed_message.lower()
        if "anghami" in all_conv_text or "anghami" in prop_lower:
            if any(w in prop_lower for w in ["login", "log in", "fout 3al account", "credentials", "password"]):
                return {
                    "decision": "SKIP",
                    "category": "support",
                    "rule_ids": ["SUPPORT_12"],
                    "cancel_reason": "SUPPORT_12: Anghami activation does not use account login credentials",
                    "internal_reason": "Anghami uses family link or profile screenshot, never login credentials.",
                    "message": None
                }

    # 7. SUPPORT_01: Repeated identical support check already sent (unanswered)
    for m in reversed(messages):
        if (m.get("direction") or "").upper() == "INCOMING":
            break
        if (m.get("direction") or "").upper() == "OUTGOING":
            otxt = (m.get("message") or "").strip().lower()
            if any(sc in otxt for sc in ["did it work", "meshe l hal", "meche l hal", "were you able to log in", "2dert tfout", "zabat"]):
                return {
                    "decision": "SKIP",
                    "category": "support",
                    "rule_ids": ["SUPPORT_01"],
                    "cancel_reason": "SUPPORT_01: Support outcome check already pending",
                    "internal_reason": "Outcome check already delivered; waiting for customer reply.",
                    "message": None
                }

    return None


# ============================================================================
# Dispatch Gate (exact port of Fady_bot validate_dispatch_gate)
# ============================================================================

def validate_dispatch_gate(decision: str, message: Optional[str]) -> Tuple[str, str, Optional[str]]:
    """
    Exact port of Fady_bot validate_dispatch_gate().
    Enforces application-level safety checks: no URLs, emails, placeholders,
    >1 question mark, mixed scripts, or unauthorized operational claims.
    Returns (final_decision, final_message, issue_reason).
    """
    dec_upper = (decision or "SKIP").strip().upper()
    if dec_upper in ("YES", "TRUE", "FOLLOW_UP", "FOLLOWUP", "SEND_FOLLOWUP", "REPLY"):
        dec_upper = "SEND"
    elif dec_upper not in ("SEND", "SKIP"):
        dec_upper = "SKIP"

    if dec_upper != "SEND":
        return dec_upper, "", None

    msg = (message or "").strip()
    if not msg or msg.lower() in ("null", "none"):
        return "SKIP", "", "SEND decision missing message body"

    issues = []
    if re.search(r"https?\s*:\s*//|www\.|\b[a-z0-9.-]+\.(?:com|xyz|net|org)(?:/|\b)", msg, re.I):
        issues.append("URL or domain name detected in message")
    if re.search(r"[\w.+%-]+@[\w.-]+\.[A-Za-z]{2,}", msg):
        issues.append("Email address detected in message")
    if "{" in msg or "}" in msg or re.search(r"\[(?:ACCOUNT|PHONE|CREDENTIAL|SECRET|ACCESS|IDENTIFIER)", msg):
        issues.append("Unresolved placeholder detected in message")
    if msg.count("?") + msg.count("\u061f") > 1:
        issues.append("More than one question mark in message")
    if re.search(r"[\u0600-\u06ff]", msg) and re.search(r"[A-Za-z]", msg):
        issues.append("Mixed script detected in message")
    if re.search(r"\b(?:we(?:'re| are| will| have)|i(?:'m| am| will| have))\s+(?:now\s+)?(?:fix|activat|refund|cancel|replac|send|check)", msg, re.I):
        issues.append("Unauthorized operational claim detected")
    if re.search(r"\b(?:sending you(?: the)?|bebaatlik|wselek l refund|fixed it from the system|manager will contact|okay check now)\b", msg, re.I):
        issues.append("Unauthorized operational claim detected")
    if re.search(r"\b(?:zero limits|last chance|guaranteed no issues)\b", msg, re.I):
        issues.append("Unsupported pressure claim detected")

    if issues:
        return "SKIP", "", "; ".join(issues)

    return "SEND", msg, None


# ============================================================================
# Transcript Formatting (exact port of Fady_bot format_chat_transcript)
# ============================================================================

def format_chat_transcript(messages: List[Dict[str, Any]], max_tokens: int = 4000) -> str:
    """
    Exact port of Fady_bot format_chat_transcript().
    Formats messages into a readable transcript, truncating oldest if over token budget.
    """
    if not messages:
        return ""

    char_budget = max_tokens * 4
    formatted_lines = []
    total_chars = 0
    truncated = False

    for msg in reversed(messages):
        direction = (msg.get("direction") or "").upper()
        sender = "Customer" if direction == "INCOMING" else "Support/Business"
        text = (msg.get("message") or "").strip()
        time_str = msg.get("timestamp", "")
        if text:
            line = f"[{time_str}] {sender}: {text}"
            line_len = len(line) + 1
            if total_chars + line_len > char_budget and formatted_lines:
                truncated = True
                break
            formatted_lines.append(line)
            total_chars += line_len

    formatted_lines.reverse()
    if truncated:
        formatted_lines.insert(0, "[... Earlier conversation history truncated to preserve token budget ...]")

    return "\n".join(formatted_lines)


def summarize_transcript(transcript: str) -> str:
    """Creates a concise context summary for RAG indexing."""
    lines = [l for l in transcript.strip().split("\n") if l.strip() and not l.startswith("[... Earlier")]
    if not lines:
        return "Empty conversation"
    recent = " | ".join(lines[-3:])
    return f"Recent messages: {recent}"


# ============================================================================
# Model Utilities
# ============================================================================

def is_fixed_temperature_model(model_name: str) -> bool:
    """
    Exact port of Fady_bot is_fixed_temperature_model().
    Returns True for reasoning models and gpt-5 series that reject custom temperature.
    """
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


def extract_json_object(text: str) -> Dict[str, Any]:
    """
    Exact port of Fady_bot extract_json_object().
    Robustly extracts JSON from model response, handling markdown fences and extra text.
    """
    clean = (text or "").strip()
    if not clean:
        raise json.JSONDecodeError("Empty response from model", clean, 0)

    # 1. Direct parse
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        pass

    # 2. Extract from markdown code fence
    match = re.search(r"```(?:json)?\s*(.*?)\s*```", clean, re.DOTALL)
    if match:
        block_text = match.group(1).strip()
        try:
            return json.loads(block_text)
        except json.JSONDecodeError:
            pass

    # 3. Robust JSONDecoder scan
    decoder = json.JSONDecoder()
    pos = 0
    while True:
        idx = clean.find("{", pos)
        if idx == -1:
            break
        try:
            obj, _ = decoder.raw_decode(clean[idx:])
            if isinstance(obj, dict):
                return obj
            pos = idx + 1
        except json.JSONDecodeError:
            pos = idx + 1

    return json.loads(clean)


def execute_chat_completion_with_retry(
    client: OpenAI,
    kwargs: Dict[str, Any],
    max_retries: int = 3,
    initial_delay: float = 1.0,
    backoff_factor: float = 2.0
) -> Any:
    """
    Exact port of Fady_bot execute_chat_completion_with_retry().
    Exponential backoff on rate limits, safe temperature fallback for restricted models.
    """
    model = kwargs.get("model", "")
    if is_fixed_temperature_model(model):
        kwargs.pop("temperature", None)

    rf = kwargs.get("response_format")
    is_json_mode = True
    if isinstance(rf, dict) and rf.get("type") and rf.get("type") != "json_object":
        is_json_mode = False
    elif hasattr(rf, "type") and getattr(rf, "type") and getattr(rf, "type") != "json_object":
        is_json_mode = False

    if is_json_mode:
        messages = kwargs.get("messages", [])
        has_json = False
        for m in messages:
            content = m.get("content")
            if isinstance(content, str):
                if "json" in content.lower():
                    has_json = True
                    break
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and "json" in str(part.get("text", "")).lower():
                        has_json = True
                        break
                if has_json:
                    break

        if not has_json:
            if not messages:
                messages.append({"role": "user", "content": "Respond strictly in JSON format."})
                kwargs["messages"] = messages
            else:
                last_content = messages[-1].get("content")
                if isinstance(last_content, str):
                    messages[-1]["content"] += " You must respond strictly in JSON format."
                elif isinstance(last_content, list):
                    messages[-1]["content"].append({"type": "text", "text": "You must respond strictly in JSON format."})
                elif last_content is None:
                    messages[-1]["content"] = "Respond strictly in JSON format."
                else:
                    messages[-1]["content"] = str(last_content) + " You must respond strictly in JSON format."

    for attempt in range(max_retries + 1):
        try:
            return client.chat.completions.create(**kwargs)
        except Exception as e:
            err_msg = str(e).lower()

            if "temperature" in err_msg and ("unsupported" in err_msg or "default" in err_msg or "allowed" in err_msg or "not support" in err_msg):
                if "temperature" in kwargs:
                    kwargs.pop("temperature", None)
                    continue

            if "response_format" in err_msg and ("unsupported" in err_msg or "not support" in err_msg or "allowed" in err_msg or "not valid" in err_msg):
                if "response_format" in kwargs:
                    kwargs.pop("response_format", None)
                    continue

            is_429 = False
            if hasattr(e, "status_code") and getattr(e, "status_code") == 429:
                is_429 = True
            elif "429" in err_msg or "rate limit" in err_msg or "ratelimit" in type(e).__name__.lower():
                is_429 = True

            if is_429 and attempt < max_retries:
                delay = initial_delay * (backoff_factor ** attempt)
                if hasattr(e, "response") and getattr(e, "response") is not None:
                    headers = getattr(e.response, "headers", None) or {}
                    retry_header = headers.get("retry-after") or headers.get("retry-after-ms") if hasattr(headers, "get") else None
                    if retry_header:
                        try:
                            val = float(retry_header)
                            if val > 1000 and "ms" in str(headers.get("retry-after-ms", "")):
                                val = val / 1000.0
                            delay = min(max(delay, val), 60.0)
                        except (ValueError, TypeError):
                            pass
                time.sleep(delay)
                continue

            raise e


# ============================================================================
# Single Contact Analysis (exact port of Fady_bot analyze_contact_thread)
# ============================================================================

def analyze_contact_thread(
    contact: str,
    profile_name: str,
    client: OpenAI,
    chat_model: str,
    temperature: float,
    system_prompt: str,
    ref_dt: datetime,
    emb_model: str = "text-embedding-3-small",
    top_k_canonical: int = 6,
    top_k_feedback: int = 5
) -> Dict[str, Any]:
    """
    Exact port of Fady_bot analyze_contact_thread() — uses Supabase/pgvector instead of SQLite.
    Enforces 24h window, all cancellation guards, dispatch gate, RAG, retry logic.
    """
    conn = connect_db()
    cur = conn.cursor(cursor_factory=RealDictCursor)

    try:
        # Fetch full message history (all messages, ASC order) — same as Fady_bot
        cur.execute("""
            SELECT direction, message, timestamp, status
            FROM bsb_messages
            WHERE contact = %s
            ORDER BY timestamp ASC, id ASC
        """, (contact,))
        messages = [dict(r) for r in cur.fetchall()]

        if not messages:
            return {
                "decision": "SKIP",
                "send_followup": False,
                "reasoning": "No chat messages found for contact.",
                "cancel_reason": "No chat messages found for contact.",
                "message": "",
                "category": "guardrails",
                "rule_ids": ["GUARD_01"],
                "internal_reason": "No chat messages found for contact.",
                "context_summary": ""
            }

        # === STEP 1: 24h Window Eligibility (exact Fady_bot logic) ===
        is_eligible, ineligibility_reason, cancel_reason = check_24h_window_eligibility(
            messages=messages,
            ref_dt=ref_dt,
            min_hours=2.0,
            max_hours=24.0
        )

        if not is_eligible:
            return {
                "decision": "SKIP",
                "send_followup": False,
                "reasoning": ineligibility_reason,
                "cancel_reason": cancel_reason,
                "message": "",
                "category": "guardrails",
                "rule_ids": ["GUARD_01"],
                "internal_reason": ineligibility_reason,
                "context_summary": ""
            }

        # === STEP 2: Format transcript & context summary ===
        transcript = format_chat_transcript(messages)
        context_summary = summarize_transcript(transcript)
        retrieval_query = f"{context_summary}\n{transcript}"

        # === STEP 3: RAG — canonical rules via pgvector ===
        query_vector = None
        try:
            emb_resp = client.embeddings.create(input=[retrieval_query[-1500:]], model=emb_model)
            query_vector = emb_resp.data[0].embedding
        except Exception as e:
            print(f"[WARN] Embedding failed for {contact}: {e}")

        canonical_text = ""
        if query_vector:
            try:
                cur.execute("""
                    SELECT id, title, category, reason, preferred_messages
                    FROM match_canonical_rules(%s::vector, 0.25, %s)
                """, (str(query_vector), top_k_canonical))
                canonical_rules = cur.fetchall()
                if canonical_rules:
                    r_lines = []
                    for r in canonical_rules:
                        pref = r.get("preferred_messages") or {}
                        if isinstance(pref, str):
                            try:
                                pref = json.loads(pref)
                            except Exception:
                                pref = {}
                        arabizi = pref.get("lebanese_arabizi", [])
                        arabizi_txt = f" (Preferred Arabizi: {arabizi})" if arabizi else ""
                        r_lines.append(f"- [{r['id']}] {r['title']}: {r['reason']}{arabizi_txt}")
                    canonical_text = "### CANONICAL KNOWLEDGE RULES (v2.0):\n" + "\n".join(r_lines)
            except Exception as e:
                print(f"[WARN] Canonical rules retrieval failed for {contact}: {e}")

        # === STEP 4: RAG — past human feedback/corrections ===
        feedback_text = ""
        if query_vector:
            try:
                cur.execute("""
                    SELECT contact, context_summary, original_draft, final_msg, review_action
                    FROM match_feedback_learning(%s::vector, 0.35, %s)
                """, (str(query_vector), top_k_feedback))
                fb_records = cur.fetchall()
                if fb_records:
                    fb_lines = []
                    for fb in fb_records:
                        act = fb.get("review_action") or "OPERATOR"
                        summary = fb.get("context_summary") or ""
                        if act == "CANCELLED":
                            fb_lines.append(f"- [DO NOT MESSAGE] Context: '{summary}' -> Human operator cancelled. Decision: SKIP.")
                        elif act == "MODIFIED":
                            fb_lines.append(f"- [HUMAN CORRECTION] Context: '{summary}'. Operator sent: '{fb.get('final_msg')}'.")
                        elif act == "APPROVED":
                            fb_lines.append(f"- [APPROVED EXAMPLE] Context: '{summary}'. Sent: '{fb.get('final_msg') or fb.get('original_draft')}'.")
                    feedback_text = "### DYNAMIC OPERATOR REVIEWS & CORRECTIONS:\n" + "\n".join(fb_lines)
            except Exception as e:
                print(f"[WARN] Feedback retrieval failed for {contact}: {e}")

        # === STEP 5: Build system message (same structure as Fady_bot) ===
        prompt_sections = [system_prompt]
        if feedback_text:
            prompt_sections.append(feedback_text)
        if canonical_text:
            prompt_sections.append(canonical_text)
        prompt_sections.append("Respond strictly with a valid JSON object matching the requested schema.")
        system_message = "\n\n".join(prompt_sections)

        user_message = (
            f"Customer Phone: {contact}\n"
            f"Profile Name: {profile_name}\n\n"
            f"System Precondition: WhatsApp 24h session window eligibility, timing cadence, and safety dispatch gates are already verified by the host system.\n\n"
            f"Full Conversation History:\n{transcript}\n\n"
            f"Analyze this conversation and generate follow-up decision according to guidelines. Output must be a valid JSON object."
        )

        # === STEP 6: OpenAI call with retry (exact Fady_bot logic) ===
        kwargs = {
            "model": chat_model,
            "messages": [
                {"role": "system", "content": system_message},
                {"role": "user", "content": user_message}
            ],
            "response_format": {"type": "json_object"}
        }

        if temperature is not None and temperature != 1.0:
            if not is_fixed_temperature_model(chat_model):
                kwargs["temperature"] = temperature

        response = execute_chat_completion_with_retry(client, kwargs)
        content = response.choices[0].message.content or ""
        raw_result = extract_json_object(content)

        # === STEP 7: Parse response (exact Fady_bot schema mapping) ===
        raw_decision = str(raw_result.get("decision", "")).strip().upper()
        raw_msg = raw_result.get("message")
        if raw_msg is None:
            raw_msg = raw_result.get("followup_message")

        rule_ids = raw_result.get("rule_ids", [])
        if isinstance(rule_ids, str):
            try:
                rule_ids = json.loads(rule_ids)
            except Exception:
                rule_ids = [rule_ids] if rule_ids else []
        elif not isinstance(rule_ids, list):
            rule_ids = []

        if "send_followup" in raw_result and "decision" not in raw_result:
            raw_decision = "SEND" if raw_result["send_followup"] else "SKIP"

        # Normalize legacy decisions
        if raw_decision in ("NO_MESSAGE", "DEFER", "HUMAN_REVIEW"):
            raw_decision = "SKIP"

        # Enforce Anghami login restriction
        if raw_msg and ("anghami" in retrieval_query.lower() or "anghami" in str(raw_msg).lower()):
            if any(w in str(raw_msg).lower() for w in ["login", "log in", "fout 3al account"]):
                raw_decision = "SKIP"
                raw_msg = ""

        # === STEP 8: Canonical cancellation guards (post-LLM, same as Fady_bot) ===
        gate_issue = None
        if raw_decision == "SEND":
            cancellation_guard = check_canonical_cancellation_guards(messages, proposed_message=raw_msg)
            if cancellation_guard is not None:
                raw_decision = "SKIP"
                raw_msg = ""
                gate_issue = cancellation_guard["cancel_reason"]
                rule_ids = cancellation_guard["rule_ids"]

        # === STEP 9: Application-level dispatch gate ===
        v2_decision, clean_msg, dispatch_issue = validate_dispatch_gate(raw_decision, raw_msg)
        if dispatch_issue and not gate_issue:
            gate_issue = dispatch_issue
            if "GUARD_02" not in rule_ids:
                rule_ids.append("GUARD_02")

        category = str(raw_result.get("category") or raw_result.get("intent") or "sales").strip()
        internal_reason = (raw_result.get("internal_reason") or raw_result.get("explanation") or raw_result.get("reasoning") or "")

        send_followup = (v2_decision == "SEND" and bool(clean_msg))
        followup_msg = clean_msg if send_followup else ""

        if internal_reason and category and category.lower() not in internal_reason.lower():
            reasoning = f"[{category}] {internal_reason}"
        elif internal_reason:
            reasoning = internal_reason
        elif category:
            reasoning = category
        else:
            reasoning = "AI determined follow-up decision"

        cancel_reason_final = ""
        if not send_followup:
            if gate_issue:
                cancel_reason_final = f"Safety gate issue: {gate_issue}"
            else:
                cancel_reason_final = reasoning or "AI determined no follow-up needed"

        return {
            "decision": "SEND" if send_followup else "SKIP",
            "send_followup": send_followup,
            "followup_message": followup_msg,
            "message": followup_msg,
            "category": category,
            "rule_ids": rule_ids,
            "internal_reason": internal_reason,
            "reasoning": reasoning,
            "context_summary": context_summary,
            "cancel_reason": cancel_reason_final
        }

    except json.JSONDecodeError as json_err:
        return {
            "decision": "SKIP",
            "send_followup": False,
            "reasoning": f"JSON parse error from model response: {str(json_err)}",
            "cancel_reason": "JSON formatting error from OpenAI response",
            "message": "",
            "category": "ERROR",
            "rule_ids": ["GUARD_02"],
            "internal_reason": f"JSON parse error: {str(json_err)}",
            "context_summary": ""
        }
    except Exception as e:
        return {
            "decision": "SKIP",
            "send_followup": False,
            "reasoning": f"OpenAI API Error: {str(e)}",
            "cancel_reason": f"OpenAI API Error: {str(e)}",
            "message": "",
            "category": "ERROR",
            "rule_ids": ["GUARD_02"],
            "internal_reason": f"OpenAI API Error: {str(e)}",
            "context_summary": ""
        }
    finally:
        cur.close()
        conn.close()


# ============================================================================
# DB Write — Save Draft (thread-safe, one connection per call)
# ============================================================================

def save_draft(contact: str, profile_name: str, analysis: Dict[str, Any]):
    """Inserts analysis result into followup_drafts (Supabase). Rescanning replaces previous CANCELLED evaluations."""
    send_followup = analysis.get("send_followup", False)
    message = analysis.get("message", "") or ""
    reasoning = analysis.get("reasoning", "")
    category = analysis.get("category", "sales")
    rule_ids = analysis.get("rule_ids", [])
    internal_reason = analysis.get("internal_reason", "")
    cancel_reason = analysis.get("cancel_reason", "")
    decision = "SEND" if send_followup else "SKIP"
    status = "PENDING" if send_followup else "CANCELLED"

    conn = connect_db()
    cur = conn.cursor()
    try:
        # If there were previous CANCELLED (no-draft) records for this contact, remove them so contact is clean
        cur.execute("DELETE FROM followup_drafts WHERE contact = %s AND status = 'CANCELLED'", (contact,))

        cur.execute("""
            INSERT INTO followup_drafts
                (contact, profile_name, drafted_msg, reasoning, decision, category,
                 rule_ids, internal_reason, status)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (
            contact,
            profile_name,
            message if send_followup else None,
            reasoning,
            decision,
            category,
            json.dumps(rule_ids),
            internal_reason,
            status
        ))
    finally:
        cur.close()
        conn.close()


# ============================================================================
# Main Scan Execution (exact port of Fady_bot generate_drafts_for_unprocessed)
# ============================================================================

def execute_server_scan(limit: Optional[int] = None, job_id: Optional[int] = None) -> Dict[str, Any]:
    """
    Exact port of Fady_bot generate_drafts_for_unprocessed() — on Supabase.
    Finds eligible contacts, analyzes each thread, stores drafts.
    """
    conn = get_db()
    cur = conn.cursor(cursor_factory=RealDictCursor)

    if job_id:
        cur.execute("UPDATE scan_jobs SET status = 'RUNNING', started_at = NOW() WHERE id = %s", (job_id,))

    print(f"\n[SERVER SCANNER] Querying eligible 24h contacts (≥2h old) from bsb_messages...")

    # 1. Fetch eligible contacts directly via fast SQL RPC function
    cur.execute("""
        SELECT contact, profile_name, last_ts
        FROM get_eligible_scan_contacts(24, 2.0);
    """)
    eligible = cur.fetchall()
    if limit:
        eligible = eligible[:limit]

    total_eligible = len(eligible)
    print(f"[SERVER SCANNER] Found {total_eligible} eligible contacts to evaluate.")

    if total_eligible == 0:
        if job_id:
            cur.execute("""
                UPDATE scan_jobs
                SET status = 'COMPLETED', completed_at = NOW(),
                    total_contacts = 0, total_evaluated = 0, drafts_created = 0, skipped = 0, human_review = 0
                WHERE id = %s
            """, (job_id,))
        cur.close()
        conn.close()
        return {"total_evaluated": 0, "drafts_created": 0, "skipped": 0, "human_review": 0}

    if job_id:
        cur.execute("""
            UPDATE scan_jobs
            SET status = 'RUNNING', started_at = NOW(), total_contacts = %s,
                total_evaluated = 0, drafts_created = 0, skipped = 0, human_review = 0
            WHERE id = %s
        """, (total_eligible, job_id))

    # Load config once for the whole batch
    client, chat_model, temperature = get_openai_client_and_model()
    system_prompt = load_system_prompt()
    ref_dt = get_reference_now()

    stats = {"total_evaluated": 0, "drafts_created": 0, "skipped": 0, "human_review": 0, "errors": 0}

    def process_contact_task(c_info: Dict[str, Any]) -> Dict[str, Any]:
        contact = c_info["contact"]
        p_name = c_info.get("profile_name") or ""
        try:
            analysis = analyze_contact_thread(
                contact=contact,
                profile_name=p_name,
                client=client,
                chat_model=chat_model,
                temperature=temperature,
                system_prompt=system_prompt,
                ref_dt=ref_dt
            )
            save_draft(contact, p_name, analysis)
            return {"contact": contact, "decision": analysis.get("decision", "SKIP"), "analysis": analysis}
        except Exception as e:
            return {"contact": contact, "decision": "ERROR", "error": str(e)}

    # Multi-threaded execution (5 workers, same as Fady_bot default)
    max_workers = 5
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(process_contact_task, c): c["contact"] for c in eligible}

        completed_count = 0
        for future in as_completed(futures):
            res = future.result()
            stats["total_evaluated"] += 1
            completed_count += 1

            dec = res.get("decision", "ERROR")
            if dec == "SEND":
                stats["drafts_created"] += 1
            elif dec in ("SKIP", "NO_MESSAGE"):
                stats["skipped"] += 1
            else:
                stats["errors"] += 1

            print(f"[{completed_count}/{total_eligible}] {res.get('contact')} -> {dec}")

            # Live progress update and status check for UI pause/stop
            if job_id:
                try:
                    cur.execute("SELECT status FROM scan_jobs WHERE id = %s", (job_id,))
                    row = cur.fetchone()
                    st = (row.get("status") or "").upper() if row else ""
                    if st in ("STOPPED", "CANCELLED", "STOP"):
                        print(f"[SERVER SCANNER] Job #{job_id} stopped by user. Halting scan.")
                        break
                    while st == "PAUSED":
                        time.sleep(2.0)
                        cur.execute("SELECT status FROM scan_jobs WHERE id = %s", (job_id,))
                        r2 = cur.fetchone()
                        st = (r2.get("status") or "").upper() if r2 else ""
                        if st in ("STOPPED", "CANCELLED", "STOP"):
                            print(f"[SERVER SCANNER] Job #{job_id} stopped while paused. Halting.")
                            break

                    cur.execute("""
                        UPDATE scan_jobs
                        SET status = 'RUNNING', total_evaluated = %s, drafts_created = %s,
                            skipped = %s, human_review = %s, current_contact = %s
                        WHERE id = %s
                    """, (
                        stats["total_evaluated"], stats["drafts_created"],
                        stats["skipped"], stats["human_review"],
                        str(res.get("contact") or ""), job_id
                    ))
                except Exception as e:
                    print(f"[JOB UPDATE WARNING] {e}")

    if job_id:
        cur.execute("SELECT status FROM scan_jobs WHERE id = %s", (job_id,))
        final_row = cur.fetchone()
        final_st = (final_row.get("status") or "").upper() if final_row else ""
        if final_st not in ("STOPPED", "CANCELLED", "STOP"):
            cur.execute("""
                UPDATE scan_jobs
                SET status = 'COMPLETED', completed_at = NOW(),
                    total_evaluated = %s, drafts_created = %s, skipped = %s, human_review = %s, current_contact = ''
                WHERE id = %s
            """, (stats["total_evaluated"], stats["drafts_created"], stats["skipped"], stats["human_review"], job_id))

    cur.close()
    conn.close()

    print(f"\n[SERVER SCANNER COMPLETE] Evaluated: {stats['total_evaluated']}, Drafts: {stats['drafts_created']}, Skipped: {stats['skipped']}")
    return stats


# ============================================================================
# Queue Dispatcher
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


def get_bsb_sender_session(agent_key: str = "0670126f7e99ae241c84d3a6d32e84c2"):
    """Creates an authenticated BestSMSBulk session using valid agent secret key."""
    import requests
    s = requests.Session()
    s.headers.update({
        "User-Agent": "Mozilla/5.0 (X-UA-Compatible; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        "Origin": "https://www.bestsmsbulk.com",
        "Referer": "https://www.bestsmsbulk.com/pro-livechat/users.html"
    })
    try:
        r = s.post("https://www.bestsmsbulk.com/pro-livechat/api/validate-key.php", data={"secret_key": agent_key, "force_login": "1"}, timeout=15)
        res = r.json()
        if res.get("success"):
            return s
    except Exception as e:
        print(f"[BSB SESSION ERROR] {e}")
    return None


def send_livechat_message(session, destination: str, message: str) -> Dict[str, Any]:
    """Sends WhatsApp message via BSB LiveChat OneBox session endpoint."""
    try:
        import uuid
        req_id = "fady_" + uuid.uuid4().hex[:12]
        res = session.post(
            "https://www.bestsmsbulk.com/pro-livechat/php/send-message.php",
            data={
                "incoming_id": str(destination),
                "message": message,
                "request_id": req_id
            },
            timeout=25
        )
        try:
            res_json = res.json()
        except Exception:
            res_json = {"raw": res.text, "status_code": res.status_code}
        res_json["status_code"] = res.status_code
        return res_json
    except Exception as e:
        return {"success": False, "error": str(e)}


def process_server_queue(max_items: int = 50, dry_run: bool = False):
    """Dispatches QUEUED messages from send_queue with 1.5s delay during working hours."""
    if not is_beirut_working_hours():
        print("[QUEUE DISPATCHER] Outside Beirut working hours (09:00 - 21:00). Skipping dispatch.")
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

    print(f"[QUEUE DISPATCHER] Found {len(items)} queued messages. Dispatching (dry_run: {dry_run})...")

    # Fetch configured agent key or credentials from followup_config
    cur.execute("SELECT value FROM followup_config WHERE key = 'bestsmsbulk';")
    cfg_row = cur.fetchone()
    sms_cfg = cfg_row["value"] if cfg_row and cfg_row.get("value") else {}
    agent_key = sms_cfg.get("agent_key", "0670126f7e99ae241c84d3a6d32e84c2")
    api_key = sms_cfg.get("api_key", "teshrij")
    api_secret = sms_cfg.get("api_secret", "Teshrij123")
    api_endpoint = sms_cfg.get("api_endpoint", "https://www.bestsmsbulk.com/bestsmsbulkapi/whatsappmsging/sendMessage.php")

    # Initialize authenticated session
    bsb_session = None
    if not dry_run:
        bsb_session = get_bsb_sender_session(agent_key)
        if not bsb_session:
            print("[QUEUE DISPATCHER] Warning: LiveChat session login failed, will try legacy API endpoint.")

    for item in items:
        qid = item["id"]
        contact = item["contact"]
        msg = item["message"]
        norm = normalize_phone(contact)

        if dry_run:
            print(f"[QUEUE DISPATCHER DRY-RUN] Would send to {norm}: {msg[:35]}...")
            cur.execute("UPDATE send_queue SET status = 'SENT', sent_at = NOW() WHERE id = %s", (qid,))
            if item.get("draft_id"):
                cur.execute("UPDATE followup_drafts SET status = 'SENT' WHERE id = %s", (item["draft_id"],))
            time.sleep(1.5)
            continue

        try:
            res_json = None
            success = False

            # Primary dispatcher: LiveChat authenticated session
            if bsb_session:
                res_json = send_livechat_message(bsb_session, norm, msg)
                success = res_json.get("success") is True

            # Fallback dispatcher: Direct sendMessage API
            if not success:
                resp = requests.post(
                    api_endpoint,
                    json={
                        "api_key": api_key,
                        "api_secret": api_secret,
                        "destination": norm,
                        "message": msg
                    },
                    timeout=15
                )
                try:
                    fallback_json = resp.json()
                except Exception:
                    fallback_json = {"raw": resp.text, "status_code": resp.status_code}
                if resp.status_code == 200 and fallback_json.get("status") != "error" and fallback_json.get("success") is not False:
                    success = True
                    res_json = fallback_json
                elif not res_json:
                    res_json = fallback_json

            if success:
                cur.execute("UPDATE send_queue SET status = 'SENT', sent_at = NOW(), api_response = %s WHERE id = %s", (json.dumps(res_json), qid))
                if item.get("draft_id"):
                    cur.execute("UPDATE followup_drafts SET status = 'SENT' WHERE id = %s", (item["draft_id"],))
                print(f"[QUEUE DISPATCHER] ✓ Dispatched to {norm}")
            else:
                err_text = json.dumps(res_json) if res_json else "Unknown dispatch error"
                cur.execute("UPDATE send_queue SET status = 'FAILED', attempts = COALESCE(attempts,0) + 1, error_message = %s WHERE id = %s", (err_text, qid))
                print(f"[QUEUE DISPATCHER] ❌ Failed to {norm}: {err_text}")
        except Exception as e:
            cur.execute("UPDATE send_queue SET status = 'FAILED', attempts = COALESCE(attempts,0) + 1, error_message = %s WHERE id = %s", (str(e), qid))
            print(f"[QUEUE DISPATCHER] ❌ Error to {norm}: {e}")

        time.sleep(1.5)

    cur.close()
    conn.close()


# ============================================================================
# Server Daemon
# ============================================================================

def on_demand_listener_loop():
    print("[DAEMON] On-demand UI scan listener started (polling every 1.0s)...")
    while True:
        try:
            conn = get_db()
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("SELECT id FROM scan_jobs WHERE status = 'PENDING' ORDER BY requested_at ASC LIMIT 1")
            pending_job = cur.fetchone()
            job_id = None
            if pending_job:
                job_id = pending_job["id"]
                cur.execute("UPDATE scan_jobs SET status = 'RUNNING', started_at = NOW() WHERE id = %s", (job_id,))
            cur.close()
            conn.close()

            if job_id:
                print(f"\n[DAEMON] Detected on-demand scan request (Job #{job_id}). Executing...")
                execute_server_scan(limit=None, job_id=job_id)
        except Exception as e:
            print(f"[ON-DEMAND LISTENER ERROR] {e}")
        time.sleep(1.0)


def run_server_daemon(interval_minutes: int = 15):
    """
    Continuous server-side daemon.
    1. Dedicated thread listens for on-demand scan_jobs from Web UI.
    2. Scheduled scan every interval_minutes.
    3. send_queue dispatch with 1.5s delay.
    """
    print("================================================================")
    print(" Teshrij Server-Side Follow-up Automation Daemon Started")
    print(f" Periodic Scan: Every {interval_minutes} minutes")
    print(" On-Demand UI Listener: Active (instant dedicated thread)")
    print(" Queue Dispatcher: Active (1.5s delay, 9 AM - 9 PM Beirut)")
    print("================================================================")

    listener_thread = threading.Thread(target=on_demand_listener_loop, daemon=True)
    listener_thread.start()

    last_scheduled_scan = datetime.now(timezone.utc)
    last_queue_check = 0

    while True:
        try:
            now = datetime.now(timezone.utc)
            if (now - last_scheduled_scan).total_seconds() >= interval_minutes * 60:
                print(f"[DAEMON] {interval_minutes}-minute scheduled scan interval reached. Starting...")
                execute_server_scan(limit=None)
                last_scheduled_scan = now

            if time.time() - last_queue_check >= 15:
                process_server_queue()
                last_queue_check = time.time()

        except Exception as e:
            print(f"[DAEMON ERROR] {e}")

        time.sleep(3.0)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--daemon":
        run_server_daemon(interval_minutes=15)
    else:
        execute_server_scan(limit=None)
