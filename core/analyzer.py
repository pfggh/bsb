"""
AI Analysis Engine using OpenAI API.
Ingests contact conversation history, enforces 24-hour WhatsApp session messaging rules,
retrieves past feedback via continuous RAG, and synthesizes structured JSON follow-up drafts.
"""

import os
import json
import yaml
import time
import re
from datetime import datetime
from typing import Dict, Any, List, Optional, Tuple
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from openai import OpenAI
from core.db import get_db_connection, DEFAULT_DB_PATH
from core.learning import (
    retrieve_relevant_rules,
    format_rules_for_prompt,
    retrieve_canonical_rules,
    format_canonical_rules_for_prompt
)

DEFAULT_POLICY_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "feedback_learning_v2", "runtime_policy.txt")


def load_config(config_path: str = "config.yaml") -> Dict[str, Any]:
    """Loads system configuration from YAML file or environment."""
    cfg = {}
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}

    # Override with environment variables if present
    api_key = os.environ.get("OPENAI_API_KEY")
    if api_key:
        cfg.setdefault("openai", {})["api_key"] = api_key

    sms_key = os.environ.get("BESTSMSBULK_API_KEY")
    if sms_key:
        cfg.setdefault("bestsmsbulk", {})["api_key"] = sms_key

    sms_secret = os.environ.get("BESTSMSBULK_API_SECRET")
    if sms_secret:
        cfg.setdefault("bestsmsbulk", {})["api_secret"] = sms_secret

    return cfg


def get_openai_client(config: Dict[str, Any]) -> Optional[OpenAI]:
    """Initializes OpenAI client if api_key is available."""
    key = config.get("openai", {}).get("api_key") or os.environ.get("OPENAI_API_KEY")
    if not key or key == "your_openai_api_key_here":
        return None
    return OpenAI(api_key=key)


def load_system_prompt(
    prompt_path: str = "prompts/system_prompt.txt",
    policy_path: str = DEFAULT_POLICY_PATH
) -> str:
    """
    Loads base prompt instructions along with always-on Teshrij Follow-up Policy v2.0
    and enforces strict JSON response schema.
    """
    policy = ""
    if os.path.exists(policy_path):
        with open(policy_path, "r", encoding="utf-8") as f:
            policy = f.read().strip()

    base = ""
    if os.path.exists(prompt_path):
        with open(prompt_path, "r", encoding="utf-8") as f:
            base = f.read().strip()

    prompt_parts = []
    if policy:
        prompt_parts.append(policy)
    if base:
        prompt_parts.append(base)

    combined = "\n\n".join(prompt_parts).strip()
    if not combined:
        combined = "You are an intelligent WhatsApp follow-up assistant. Respond strictly in valid JSON format."

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


def validate_dispatch_gate(decision: str, message: Optional[str]) -> Tuple[str, str, Optional[str]]:
    """
    Enforces application-level dispatch gates outside RAG:
    - No URLs or domain names in customer message
    - No email addresses
    - No unresolved template placeholders
    - At most one question mark (? or \u061f)
    - No mixed Arabic and Latin scripts in single message
    - No unauthorized operational claims
    - No unsupported pressure claims
    Returns (final_decision, final_message, issue_reason)
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
        # Route to SKIP to prevent unsafe dispatch
        return "SKIP", "", "; ".join(issues)

    return "SEND", msg, None


def parse_timestamp_str(ts_val: Any) -> Optional[datetime]:
    """Parses various datetime string formats stored in SQLite."""
    if not ts_val:
        return None
    if isinstance(ts_val, datetime):
        return ts_val
    ts_str = str(ts_val).strip()
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M:%S",
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
            return datetime.strptime(ts_str, fmt)
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(ts_str)
    except Exception:
        return None


def get_latest_chat_timestamp(db_path: str = DEFAULT_DB_PATH) -> datetime:
    """Retrieves latest timestamp in SQLite chats table as fallback reference date."""
    try:
        conn = get_db_connection(db_path)
        cur = conn.cursor()
        cur.execute("SELECT MAX(timestamp) FROM chats")
        row = cur.fetchone()
        conn.close()
        if row and row[0]:
            dt = parse_timestamp_str(row[0])
            if dt:
                return dt
    except Exception:
        pass
    return datetime.now()


def get_reference_datetime(
    reference_time: Optional[Any] = None,
    config: Optional[Dict[str, Any]] = None,
    db_path: str = DEFAULT_DB_PATH
) -> datetime:
    """
    Determines reference datetime used to check the WhatsApp 24-hour session window.
    Defaults to local Lebanon system clock (Asia/Beirut), with optional fallback
    to reference CSV/dataset latest date if requested or configured.
    """
    if reference_time is not None:
        if isinstance(reference_time, datetime):
            return reference_time
        ref_str = str(reference_time).strip()
        if ref_str.lower() in ("csv_latest", "dataset_latest", "latest"):
            return get_latest_chat_timestamp(db_path)
        dt = parse_timestamp_str(ref_str)
        if dt:
            return dt

    cfg = config or {}
    analyzer_cfg = cfg.get("analyzer", {})
    cfg_ref = analyzer_cfg.get("reference_time")
    if cfg_ref:
        if isinstance(cfg_ref, datetime):
            return cfg_ref
        ref_str = str(cfg_ref).strip()
        if ref_str.lower() in ("csv_latest", "dataset_latest", "latest"):
            return get_latest_chat_timestamp(db_path)
        dt = parse_timestamp_str(ref_str)
        if dt:
            return dt

    if analyzer_cfg.get("fallback_to_csv_latest", False) or analyzer_cfg.get("use_csv_latest_date", False):
        return get_latest_chat_timestamp(db_path)

    try:
        import zoneinfo
        return datetime.now(zoneinfo.ZoneInfo("Asia/Beirut")).replace(tzinfo=None)
    except Exception:
        return datetime.now()


def check_24h_window_eligibility(
    messages: List[Dict[str, Any]],
    reference_time: Optional[Any] = None,
    config: Optional[Dict[str, Any]] = None,
    db_path: str = DEFAULT_DB_PATH
) -> Tuple[bool, str, str]:
    """
    Checks WhatsApp 24-hour session window rules:
    - If no messages: (False, 'No chat messages found for contact.', 'No chat messages found for contact.')
    - If the contact's most recent message is OUTGOING (from Teshrij) or not INCOMING:
      (False, 'Customer last message outside 24h window or already responded', 'Customer last message outside 24h window or already responded')
    - If the customer's last INCOMING message is older than 24 hours:
      (False, 'Customer last message outside 24h window or already responded', 'Customer last message outside 24h window or already responded: 24h window expired')
    - If the customer's last INCOMING message is within 24 hours:
      (True, '', '')
    """
    if not messages:
        return False, "No chat messages found for contact.", "No chat messages found for contact."

    last_msg = messages[-1]
    direction = (last_msg.get("direction") or "").strip().upper()
    analyzer_cfg = (config or {}).get("analyzer", {})
    ref_dt = get_reference_datetime(reference_time, config, db_path)

    # Normalize timezone awareness to Asia/Beirut
    try:
        import zoneinfo
        beirut_tz = zoneinfo.ZoneInfo("Asia/Beirut")
    except Exception:
        beirut_tz = None

    def normalize_dt(dt: datetime) -> datetime:
        if dt.tzinfo is not None:
            return dt.astimezone(beirut_tz).replace(tzinfo=None) if beirut_tz else dt.replace(tzinfo=None)
        return dt

    ref_dt = normalize_dt(ref_dt)

    min_hours = float(analyzer_cfg.get("min_hours_old", 2.0))
    max_hours = float(analyzer_cfg.get("max_hours_old", 24.0))

    # Verify WhatsApp 24h session window from the customer's last incoming message
    incoming_msgs = [m for m in messages if (m.get("direction") or "").strip().upper() == "INCOMING"]
    if incoming_msgs:
        last_incoming = incoming_msgs[-1]
        inc_dt = parse_timestamp_str(last_incoming.get("timestamp"))
        if inc_dt:
            inc_dt = normalize_dt(inc_dt)
            inc_hours = (ref_dt - inc_dt).total_seconds() / 3600.0
            if inc_hours > max_hours or inc_hours < -24.0:
                return False, "Customer last message outside 24h window or already responded", "Customer last message outside 24h window or already responded: 24h window expired"
    else:
        # No incoming customer message at all
        return False, "Customer last message outside 24h window or already responded", "Customer last message outside 24h window or already responded: no incoming customer messages"

    # Check the timestamp of the latest message in the thread
    ts_val = last_msg.get("timestamp")
    msg_dt = parse_timestamp_str(ts_val)
    if not msg_dt:
        return False, "Customer last message outside 24h window or already responded", "Customer last message outside 24h window or already responded: invalid timestamp"

    msg_dt = normalize_dt(msg_dt)
    delta_seconds = (ref_dt - msg_dt).total_seconds()
    hours_diff = delta_seconds / 3600.0

    # Outside window or absurd future timestamp
    if hours_diff > max_hours or hours_diff < -24.0:
        return False, "Customer last message outside 24h window or already responded", "Customer last message outside 24h window or already responded: 24h window expired"

    # Too recent rule: chat must be at least min_hours old (e.g. 2 hours) to avoid interrupting active conversation
    if hours_diff < min_hours:
        return False, f"Chat is too recent (< {min_hours:g}h old) to follow up", f"Chat is too recent (< {min_hours:g}h old, last message was {hours_diff:.1f}h ago)"

    return True, "", ""


def check_canonical_cancellation_guards(
    messages: List[Dict[str, Any]],
    proposed_message: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """
    Evaluates the conversation history against definitive cancellation rules learned
    from operator reviews in the manual fixes database. If any cancellation guard triggers,
    returns a complete NO_MESSAGE / SKIP payload to prevent inappropriate drafts from ever
    reaching human review.
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
            "decision": "NO_MESSAGE",
            "v2_decision": "SKIP",
            "send_followup": False,
            "reasoning": "GUARD_04: Latest customer message is an untranscribed voice message. Reviewer note: 'voice note last no idea what he said'.",
            "cancel_reason": "GUARD_04: Untranscribed customer voice message (do not guess intent)",
            "followup_message": "",
            "message": "",
            "category": "guardrails",
            "rule_ids": ["GUARD_04"],
            "internal_reason": "GUARD_04: Voice note as latest message requires manual review or pause.",
            "required_human_action": "Transcribe and review voice message",
            "not_before": None,
            "intent": "NO_ACTION",
            "eligible": False
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
            "decision": "NO_MESSAGE",
            "v2_decision": "SKIP",
            "send_followup": False,
            "reasoning": "SALES_10/SALES_11: Customer explicitly declined or requested customer-controlled deferral ('bredelkon khabar' / 'not at the moment').",
            "cancel_reason": "SALES_10/SALES_11: Customer soft deferral or refusal ends proactive outreach",
            "followup_message": "",
            "message": "",
            "category": "sales",
            "rule_ids": ["SALES_10", "SALES_11"],
            "internal_reason": "Customer explicitly deferred or declined further outreach.",
            "required_human_action": None,
            "not_before": None,
            "intent": "NO_ACTION",
            "eligible": False
        }

    # 3. GUARD_03: Payment reported or transfer proof sent
    payment_patterns = [
        "paid", "w2w", "whish transfer", "transferred", "sent the payment",
        "sent payment", "transfer done", "check the amount", "wselet l payment", "dafa3et",
        "hawal", "7awal", "ba3at", "b3at", "sent it"
    ]
    if any(p in last_in_text for p in payment_patterns):
        return {
            "decision": "NO_MESSAGE",
            "v2_decision": "SKIP",
            "send_followup": False,
            "reasoning": "GUARD_03: Customer reported payment or transfer. Stop automated sales pitching.",
            "cancel_reason": "GUARD_03: Payment reported by customer",
            "followup_message": "",
            "message": "",
            "category": "guardrails",
            "rule_ids": ["GUARD_03"],
            "internal_reason": "Customer reported payment; fulfillment/verification owned by operator.",
            "required_human_action": "Verify payment and fulfill order",
            "not_before": None,
            "intent": "NO_ACTION",
            "eligible": False
        }

    # 4. SALES_13: Final Followup already delivered
    has_final_outgoing = False
    final_msg_idx = -1
    for idx, m in enumerate(messages):
        if (m.get("direction") or "").upper() == "OUTGOING":
            otxt = (m.get("message") or "").strip().lower()
            if otxt.startswith("final followup;") or "(last followup)" in otxt or "(final followup)" in otxt or otxt == "last followup":
                has_final_outgoing = True
                final_msg_idx = idx

    if has_final_outgoing:
        subsequent_customer_msgs = [m for m in messages[final_msg_idx+1:] if (m.get("direction") or "").upper() == "INCOMING"]
        if not subsequent_customer_msgs:
            return {
                "decision": "NO_MESSAGE",
                "v2_decision": "SKIP",
                "send_followup": False,
                "reasoning": "SALES_13: A final sales follow-up was already delivered. Rule: proactive outreach permanently stops unless customer reopens.",
                "cancel_reason": "SALES_13: A final sales follow-up was already sent and remained unanswered",
                "followup_message": "",
                "message": "",
                "category": "sales",
                "rule_ids": ["SALES_13"],
                "internal_reason": "Final follow-up already delivered; sequence exhausted.",
                "required_human_action": None,
                "not_before": None,
                "intent": "NO_ACTION",
                "eligible": False
            }
        else:
            last_sub = subsequent_customer_msgs[-1]
            sub_txt = (last_sub.get("message") or "").strip().lower()
            if any(t in sub_txt for t in ["thank", "merci", "thx", "ok", "machi", "done", "👍", "❤️", "🙏🏻"]) and not any(q in sub_txt for q in ["?", "price", "how much", "baddak", "bade", "wanna buy"]):
                return {
                    "decision": "NO_MESSAGE",
                    "v2_decision": "SKIP",
                    "send_followup": False,
                    "reasoning": "SALES_13: Customer replied with polite closure after final follow-up. Do not restart outreach.",
                    "cancel_reason": "SALES_13: Polite closure following delivered final follow-up",
                    "followup_message": "",
                    "message": "",
                    "category": "sales",
                    "rule_ids": ["SALES_13"],
                    "internal_reason": "Customer acknowledged final follow-up with courtesy; sequence finished.",
                    "required_human_action": None,
                    "not_before": None,
                    "intent": "NO_ACTION",
                    "eligible": False
                }

    # 5. SUPPORT_06: Implicit resolution (Remedy delivered + customer thanks/reaction or business welcome)
    remedy_idx = -1
    for i, m in enumerate(messages):
        if (m.get("direction") or "").upper() == "OUTGOING":
            otxt = (m.get("message") or "").strip().lower()
            if "teshrij.xyz" in otxt or "tv.ostories.me" in otxt or "email:" in otxt or "password:" in otxt or "workspace" in otxt or "select mavos" in otxt or "anghami.com" in otxt or "try now" in otxt or "jarrib" in otxt or "jarreb" in otxt or "check now" in otxt:
                remedy_idx = i

    if remedy_idx != -1:
        subsequent = messages[remedy_idx+1:]
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
                "decision": "NO_MESSAGE",
                "v2_decision": "SKIP",
                "send_followup": False,
                "reasoning": "SUPPORT_06: Remedy acknowledged with gratitude/reaction or business welcome. Operational rule: 'thank you is an implicit confirmation that the link worked especially if 30 secs or more have passed'. Issue is resolved.",
                "cancel_reason": "SUPPORT_06: Implicit support resolution (customer confirmed via thanks/reaction)",
                "followup_message": "",
                "message": "",
                "category": "support",
                "rule_ids": ["SUPPORT_06"],
                "internal_reason": "Support remedy implicitly confirmed working; outcome checks cancelled.",
                "required_human_action": None,
                "not_before": None,
                "intent": "NO_ACTION",
                "eligible": False
            }

    # 6. SUPPORT_12: Anghami does not use login credentials
    if proposed_message:
        all_conv_text = " ".join((m.get("message") or "") for m in messages).lower()
        prop_lower = proposed_message.lower()
        if "anghami" in all_conv_text or "anghami" in prop_lower:
            if any(w in prop_lower for w in ["login", "log in", "fout 3al account", "credentials", "password"]):
                return {
                    "decision": "NO_MESSAGE",
                    "v2_decision": "SKIP",
                    "send_followup": False,
                    "reasoning": "SUPPORT_12: Anghami does not use login credentials or password login. Outcome checks about logging in are invalid and must be skipped.",
                    "cancel_reason": "SUPPORT_12: Anghami activation does not use account login credentials",
                    "followup_message": "",
                    "message": "",
                    "category": "support",
                    "rule_ids": ["SUPPORT_12"],
                    "internal_reason": "Anghami uses family link or profile screenshot, never login credentials.",
                    "required_human_action": None,
                    "not_before": None,
                    "intent": "NO_ACTION",
                    "eligible": False
                }

    # 7. SUPPORT_01: Repeated identical support check
    recent_support_check = False
    for m in reversed(messages):
        if (m.get("direction") or "").upper() == "INCOMING":
            break
        if (m.get("direction") or "").upper() == "OUTGOING":
            otxt = (m.get("message") or "").strip().lower()
            if any(sc in otxt for sc in ["did it work", "meshe l hal", "meche l hal", "were you able to log in", "2dert tfout", "zabat"]):
                recent_support_check = True
                break
    if recent_support_check:
        return {
            "decision": "NO_MESSAGE",
            "v2_decision": "SKIP",
            "send_followup": False,
            "reasoning": "SUPPORT_01/SUPPORT_05: A support outcome check was already sent and remains unanswered. Reviewer note: 'alrdy asked if meshe lhal'. Do not repeat.",
            "cancel_reason": "SUPPORT_01: Support outcome check already pending",
            "followup_message": "",
            "message": "",
            "category": "support",
            "rule_ids": ["SUPPORT_01"],
            "internal_reason": "Outcome check already delivered; waiting for customer reply.",
            "required_human_action": None,
            "not_before": None,
            "intent": "NO_ACTION",
            "eligible": False
        }

    return None


def format_chat_transcript(messages: List[Dict[str, Any]], max_tokens: int = 4000) -> str:
    """
    Formats list of message rows into a clean transcript string.
    Truncates very long chat histories to recent messages if token count exceeds limits.
    """
    if not messages:
        return ""

    char_budget = max_tokens * 4
    formatted_lines = []
    total_chars = 0
    truncated = False

    # Iterate from most recent messages backwards to prioritize recent context
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


def is_fixed_temperature_model(model_name: str) -> bool:
    """
    Checks whether the model only supports default temperature (1.0).
    Reasoning models (o1, o2, o3, o4 series) and newer gpt-5 series reject custom temperature values.
    Handles models with provider prefixes (e.g. models/o1-mini, openai/o3).
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
    Robustly extracts and parses a JSON object from model response, handling markdown fences,
    whitespace, and leading/trailing conversational text containing arbitrary braces.
    """
    clean = (text or "").strip()
    if not clean:
        raise json.JSONDecodeError("Empty response from model", clean, 0)

    # 1. Direct parse attempt
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        pass

    # 2. Extract from markdown code fence ```json ... ``` or ``` ... ```
    match = re.search(r"```(?:json)?\s*(.*?)\s*```", clean, re.DOTALL)
    if match:
        block_text = match.group(1).strip()
        try:
            return json.loads(block_text)
        except json.JSONDecodeError:
            pass

    # 3. Robust JSONDecoder raw_decode scan starting from each opening '{'
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

    # Re-raise standard JSONDecodeError
    return json.loads(clean)


def execute_chat_completion_with_retry(
    client: OpenAI,
    kwargs: Dict[str, Any],
    max_retries: int = 3,
    initial_delay: float = 1.0,
    backoff_factor: float = 2.0
) -> Any:
    """
    Executes client.chat.completions.create with exponential backoff for HTTP 429
    RateLimitError and safe temperature fallback for restricted models.
    """
    model = kwargs.get("model", "")
    if is_fixed_temperature_model(model):
        kwargs.pop("temperature", None)

    # Detect if response_format requires JSON mode (default True for Fady_bot unless explicitly set to non-json)
    rf = kwargs.get("response_format")
    is_json_mode = True
    if isinstance(rf, dict) and rf.get("type") and rf.get("type") != "json_object":
        is_json_mode = False
    elif hasattr(rf, "type") and getattr(rf, "type") and getattr(rf, "type") != "json_object":
        is_json_mode = False

    # When in JSON mode, ensure the word 'json' explicitly appears in prompt messages to prevent OpenAI 400 error
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

            # If temperature rejected as unsupported, drop temperature and retry immediately
            if "temperature" in err_msg and ("unsupported" in err_msg or "default" in err_msg or "allowed" in err_msg or "not support" in err_msg):
                if "temperature" in kwargs:
                    kwargs.pop("temperature", None)
                    continue

            # If response_format rejected as unsupported by reasoning models, drop and retry
            if "response_format" in err_msg and ("unsupported" in err_msg or "not support" in err_msg or "allowed" in err_msg or "not valid" in err_msg):
                if "response_format" in kwargs:
                    kwargs.pop("response_format", None)
                    continue

            # Detect rate limits (HTTP 429 or RateLimitError)
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


def analyze_contact_thread(
    contact: str,
    client: Optional[OpenAI],
    config: Dict[str, Any],
    db_path: str = DEFAULT_DB_PATH,
    reference_time: Optional[Any] = None,
    conn: Optional[Any] = None
) -> Dict[str, Any]:
    """
    Enforces the WhatsApp 24-hour session window rule, performs RAG retrieval
    of past reviewer feedback, and invokes OpenAI to produce a structured JSON follow-up draft.
    """
    local_conn = False
    if conn is None:
        conn = get_db_connection(db_path)
        local_conn = True

    cursor = conn.cursor()

    # Retrieve full messages history for contact ordered chronologically
    cursor.execute("""
    SELECT direction, message, timestamp
    FROM chats
    WHERE contact = ?
    ORDER BY timestamp ASC, id ASC
    """, (contact,))
    messages = [dict(r) for r in cursor.fetchall()]

    if local_conn:
        conn.close()

    if not messages:
        return {
            "decision": "NO_MESSAGE",
            "v2_decision": "SKIP",
            "send_followup": False,
            "reasoning": "No chat messages found for contact.",
            "cancel_reason": "No chat messages found for contact.",
            "followup_message": "",
            "message": "",
            "category": "guardrails",
            "rule_ids": ["GUARD_01"],
            "internal_reason": "No chat messages found for contact.",
            "required_human_action": None,
            "not_before": None,
            "intent": "NO_ACTION",
            "eligible": False
        }

    # Enforce 24-Hour WhatsApp Session Window & Last User Message Filter FIRST
    is_eligible, ineligibility_reason, cancel_reason = check_24h_window_eligibility(
        messages=messages,
        reference_time=reference_time,
        config=config,
        db_path=db_path
    )

    if not is_eligible:
        # Mark as CANCELLED immediately without burning OpenAI tokens or formatting transcripts
        return {
            "decision": "NO_MESSAGE",
            "v2_decision": "SKIP",
            "send_followup": False,
            "reasoning": ineligibility_reason,
            "cancel_reason": cancel_reason,
            "followup_message": "",
            "message": "",
            "category": "guardrails",
            "rule_ids": ["GUARD_01"],
            "internal_reason": ineligibility_reason,
            "required_human_action": None,
            "not_before": None,
            "intent": "NO_ACTION",
            "eligible": False,
            "context_summary": ""
        }

    transcript = format_chat_transcript(messages)
    context_summary = summarize_transcript(transcript)

    # Continuous RAG retrieval of canonical rules and past reviewer feedback
    top_k = config.get("learning", {}).get("top_k_rules", 5)
    top_k_can = config.get("learning", {}).get("top_k_canonical_rules", 6)
    emb_model = config.get("openai", {}).get("embedding_model", "text-embedding-3-small")

    retrieval_query = f"{context_summary}\n{transcript}"
    canonical_rules = retrieve_canonical_rules(
        current_context=retrieval_query,
        top_k=top_k_can,
        client=client,
        embedding_model=emb_model,
        db_path=db_path
    )
    canonical_text = format_canonical_rules_for_prompt(canonical_rules)

    past_rules = retrieve_relevant_rules(
        current_context=retrieval_query,
        top_k=top_k,
        client=client,
        embedding_model=emb_model,
        db_path=db_path
    )
    rules_text = format_rules_for_prompt(past_rules)

    base_prompt = load_system_prompt()
    prompt_sections = [base_prompt]
    if rules_text and "No similar historical examples found" not in rules_text:
        prompt_sections.append(rules_text)
    if canonical_text:
        prompt_sections.append(canonical_text)
    prompt_sections.append("Respond strictly with a valid JSON object matching the requested schema.")
    system_message = "\n\n".join(prompt_sections)

    user_message = (
        f"Customer Phone: {contact}\n\n"
        f"System Precondition: WhatsApp 24h session window eligibility, timing cadence, and safety dispatch gates are already verified by the host system.\n\n"
        f"Full Conversation History:\n{transcript}\n\n"
        f"Analyze this conversation and generate follow-up decision according to guidelines. Output must be a valid JSON object."
    )

    chat_model = config.get("openai", {}).get("chat_model", "gpt-4o")
    temperature = config.get("openai", {}).get("temperature", 0.3)

    if not client:
        # Graceful heuristic fallback if API key is not configured
        last_msg = messages[-1]
        last_text = last_msg.get("message", "")
        return {
            "decision": "SEND",
            "v2_decision": "SEND",
            "send_followup": True,
            "reasoning": f"Local rule fallback (No OpenAI API key set). Last message was INCOMING: '{last_text[:50]}...'",
            "cancel_reason": "",
            "followup_message": "Hello! Following up on your inquiry. Please let us know if you have any questions.",
            "message": "Hello! Following up on your inquiry. Please let us know if you have any questions.",
            "category": "sales",
            "rule_ids": ["SALES_01"],
            "internal_reason": "Local rule fallback for active lead.",
            "required_human_action": None,
            "not_before": None,
            "intent": "sales",
            "eligible": True,
            "context_summary": context_summary
        }

    try:
        kwargs = {
            "model": chat_model,
            "messages": [
                {"role": "system", "content": system_message},
                {"role": "user", "content": user_message}
            ],
            "response_format": {"type": "json_object"}
        }

        # Handle temperature safely
        if temperature is not None and temperature != 1.0:
            if not is_fixed_temperature_model(chat_model):
                kwargs["temperature"] = temperature

        response = execute_chat_completion_with_retry(client, kwargs)
        content = response.choices[0].message.content or ""
        raw_result = extract_json_object(content)

        # Map structured output schema:
        # decision: 'SEND' | 'SKIP' | 'DEFER' | 'HUMAN_REVIEW'
        # category: 'sales' | 'support' | 'guardrails' | 'style'
        # message: string or null
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

        # If send_followup is present but decision is omitted
        if "send_followup" in raw_result and "decision" not in raw_result:
            raw_decision = "SEND" if raw_result["send_followup"] else "SKIP"

        # If send_followup is present but decision is omitted
        if "send_followup" in raw_result and "decision" not in raw_result:
            raw_decision = "SEND" if raw_result["send_followup"] else "SKIP"

        # Enforce Anghami login restriction: Anghami does not use login credentials
        if raw_msg and ("anghami" in retrieval_query.lower() or "anghami" in str(raw_msg).lower()):
            if any(w in str(raw_msg).lower() for w in ["login", "log in", "fout 3al account"]):
                raw_decision = "SKIP"
                raw_msg = ""

        # Enforce canonical cancellation guards if model proposed to send
        if raw_decision == "SEND":
            cancellation_guard = check_canonical_cancellation_guards(messages, proposed_message=raw_msg)
            if cancellation_guard is not None:
                raw_decision = "SKIP"
                raw_msg = ""
                gate_issue = cancellation_guard["cancel_reason"]
                rule_ids = cancellation_guard["rule_ids"]

        # Apply application-level dispatch gates
        v2_decision, clean_msg, gate_issue = validate_dispatch_gate(raw_decision, raw_msg)

        required_human_action = raw_result.get("required_human_action")
        if gate_issue:
            required_human_action = f"Dispatch gate issue: {gate_issue}" + (f" | {required_human_action}" if required_human_action else "")
            if "GUARD_02" not in rule_ids:
                rule_ids.append("GUARD_02")

        not_before = raw_result.get("not_before")
        category = str(raw_result.get("category") or raw_result.get("intent") or "sales").strip()
        internal_reason = raw_result.get("internal_reason") or raw_result.get("explanation") or raw_result.get("reasoning") or ""

        send_followup = (v2_decision == "SEND" and bool(clean_msg))
        followup_msg = clean_msg if send_followup else ""

        # For backwards test compatibility: decision is "SEND" when sending, "NO_MESSAGE" when not
        decision = "SEND" if send_followup else "NO_MESSAGE"

        if internal_reason and category and category.lower() not in internal_reason.lower():
            reasoning = f"[{category}] {internal_reason}"
        elif internal_reason:
            reasoning = internal_reason
        elif category:
            reasoning = category
        else:
            reasoning = "AI determined follow-up decision"

        intent = category if category else "GENERAL"

        cancel_reason = ""
        if not send_followup:
            if gate_issue:
                cancel_reason = f"Safety gate issue: {gate_issue}"
            else:
                cancel_reason = reasoning or "AI determined no follow-up needed"

        return {
            "decision": decision,
            "v2_decision": v2_decision,
            "send_followup": send_followup,
            "followup_message": followup_msg,
            "message": followup_msg,
            "category": category,
            "rule_ids": rule_ids,
            "internal_reason": internal_reason,
            "reasoning": reasoning,
            "intent": intent,
            "required_human_action": required_human_action,
            "not_before": not_before,
            "context_summary": context_summary,
            "eligible": True,
            "cancel_reason": cancel_reason
        }

    except json.JSONDecodeError as json_err:
        return {
            "decision": "NO_MESSAGE",
            "v2_decision": "SKIP",
            "send_followup": False,
            "reasoning": f"JSON parse error from model response: {str(json_err)}",
            "cancel_reason": "JSON formatting error from OpenAI response",
            "followup_message": "",
            "message": "",
            "category": "ERROR",
            "rule_ids": ["GUARD_02"],
            "internal_reason": f"JSON parse error: {str(json_err)}",
            "required_human_action": None,
            "not_before": None,
            "intent": "ERROR",
            "context_summary": context_summary,
            "eligible": True
        }
    except Exception as e:
        return {
            "decision": "NO_MESSAGE",
            "v2_decision": "SKIP",
            "send_followup": False,
            "reasoning": f"OpenAI API Error: {str(e)}",
            "cancel_reason": f"OpenAI API Error: {str(e)}",
            "followup_message": "",
            "message": "",
            "category": "ERROR",
            "rule_ids": ["GUARD_02"],
            "internal_reason": f"OpenAI API Error: {str(e)}",
            "required_human_action": f"API error: {str(e)}",
            "not_before": None,
            "intent": "ERROR",
            "context_summary": context_summary,
            "eligible": True
        }


def generate_drafts_for_unprocessed(
    limit: Optional[int] = None,
    config_path: str = "config.yaml",
    db_path: str = DEFAULT_DB_PATH,
    progress_callback: Optional[Any] = None,
    reference_time: Optional[Any] = None,
    rescan_cancelled: bool = True
) -> List[Dict[str, Any]]:
    """
    Finds contacts that do not have an active or pending follow-up draft,
    analyzes each contact thread against WhatsApp 24h session rules and OpenAI RAG,
    and stores the draft in the database.
    If rescan_cancelled is True, previously CANCELLED (no message/SKIP) chats within the 24h window
    are re-evaluated.
    Uses multi-threading to parallelize OpenAI requests while strictly respecting
    rate limits and SQLite concurrency safety.
    """
    config = load_config(config_path)
    client = get_openai_client(config)

    # Resolve reference datetime once for the entire batch to avoid redundant DB queries
    resolved_ref_dt = get_reference_datetime(reference_time, config, db_path)

    conn = get_db_connection(db_path)
    cursor = conn.cursor()

    # Sync any contacts where last_interaction is NULL using their chats table
    cursor.execute("""
    UPDATE contacts
    SET last_interaction = (
        SELECT MAX(timestamp) FROM chats WHERE chats.contact = contacts.contact
    )
    WHERE last_interaction IS NULL AND EXISTS (
        SELECT 1 FROM chats WHERE chats.contact = contacts.contact
    )
    """)
    conn.commit()

    # Determine cutoff timestamps (24 hours for customer window)
    from datetime import timedelta
    cutoff_dt = resolved_ref_dt - timedelta(hours=24)
    cutoff_str = cutoff_dt.strftime("%Y-%m-%d %H:%M:%S")

    # Fast DB-level filter: Find contacts who interacted outside the past 24 hours
    # and do NOT already have a draft. Mark older contacts as CANCELLED in bulk.
    cursor.execute("""
    SELECT c.contact
    FROM contacts c
    LEFT JOIN followup_drafts f ON c.contact = f.contact
    WHERE f.id IS NULL AND c.last_interaction IS NOT NULL AND c.last_interaction < ?
    """, (cutoff_str,))
    older_contacts = [r[0] for r in cursor.fetchall()]

    bulk_created_drafts = []
    if older_contacts:
        cursor.executemany("""
        INSERT OR IGNORE INTO followup_drafts (
            contact, drafted_msg, reasoning, intent, status, cancel_reason,
            decision, category, rule_ids, internal_reason, created_at, updated_at
        ) VALUES (
            ?, '', 'Customer last message outside 24h window or already responded',
            'NO_ACTION', 'CANCELLED', 'Customer last message outside 24h window or already responded: 24h window expired',
            'SKIP', 'guardrails', '["GUARD_01"]', '24-hour WhatsApp session window expired', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        """, [(c,) for c in older_contacts])
        conn.commit()

        for c in older_contacts:
            bulk_created_drafts.append({
                "contact": c,
                "status": "CANCELLED",
                "decision": "SKIP",
                "followup_msg": "",
                "reasoning": "Customer last message outside 24h window or already responded",
                "cancel_reason": "Customer last message outside 24h window or already responded: 24h window expired"
            })

    # Query contacts needing evaluation:
    # If rescan_cancelled is True: evaluate contacts with no draft, OR whose latest draft is CANCELLED
    # If rescan_cancelled is False: only evaluate contacts with no draft, or cooldown cancelled (< 2h), or new incoming message
    cutoff_6h = resolved_ref_dt - timedelta(hours=6)
    cutoff_6h_str = cutoff_6h.strftime("%Y-%m-%d %H:%M:%S")

    params = [cutoff_str]
    if rescan_cancelled:
        cancelled_filter = "f.max_id IS NULL OR f.status = 'CANCELLED' OR (c.last_interaction > f.updated_at)"
    else:
        cancelled_filter = """
            f.max_id IS NULL
            OR (f.status = 'CANCELLED' AND (f.cancel_reason LIKE '%too recent%' OR f.cancel_reason LIKE '%< %h old%'))
            OR (c.last_interaction > f.updated_at)
            OR (f.status = 'CANCELLED' AND f.cancel_reason LIKE '%already responded%' AND c.last_interaction >= ?)
        """
        params.append(cutoff_6h_str)

    query = f"""
    SELECT c.contact, c.profile_name, c.last_interaction, c.total_messages
    FROM contacts c
    LEFT JOIN (
        SELECT contact, status, updated_at, cancel_reason, MAX(id) as max_id
        FROM followup_drafts
        GROUP BY contact
    ) f ON c.contact = f.contact
    WHERE 
        EXISTS (SELECT 1 FROM chats ch WHERE ch.contact = c.contact)
        AND (c.status IS NULL OR c.status NOT IN ('OPT_OUT', 'SUPPRESSED', 'BLOCKED'))
        AND (c.last_interaction IS NULL OR c.last_interaction >= ?)
        AND ({cancelled_filter})
    ORDER BY c.last_interaction DESC
    """
    if limit:
        query += f" LIMIT {int(limit)}"

    cursor.execute(query, params)
    contacts = [dict(r) for r in cursor.fetchall()]
    conn.close()

    created_drafts = []

    if not contacts:
        if bulk_created_drafts:
            return bulk_created_drafts[:limit] if limit else bulk_created_drafts
        return []

    # Get concurrency setting from config (default 5 workers)
    max_workers = config.get("openai", {}).get("max_workers", 5)
    try:
        max_workers = int(max_workers)
    except (ValueError, TypeError):
        max_workers = 5
    max_workers = max(1, min(max_workers, 15))

    db_lock = threading.Lock()
    processed_count = 0
    total_contacts = len(contacts)

    def process_single_contact(contact_info: Dict[str, Any]) -> Dict[str, Any]:
        nonlocal processed_count
        contact = contact_info["contact"]

        # Call thread analysis (this executes OpenAI API network call outside DB lock)
        analysis = analyze_contact_thread(
            contact=contact,
            client=client,
            config=config,
            db_path=db_path,
            reference_time=resolved_ref_dt
        )

        send_followup = analysis.get("send_followup", False)
        reasoning = analysis.get("reasoning", "")
        followup_msg = analysis.get("followup_message", "")
        intent = analysis.get("intent", "GENERAL")
        cancel_reason = analysis.get("cancel_reason", "")
        v2_decision = analysis.get("v2_decision", "SKIP")
        category = analysis.get("category", "")
        rule_ids = analysis.get("rule_ids", [])
        rule_ids_json = json.dumps(rule_ids) if isinstance(rule_ids, list) else str(rule_ids)
        internal_reason = analysis.get("internal_reason", "")
        req_action = analysis.get("required_human_action")
        not_before = analysis.get("not_before")

        if send_followup and followup_msg.strip():
            status = "PENDING"
            cancel_reason = ""
        else:
            status = "CANCELLED"
            v2_decision = "SKIP"
            if not cancel_reason:
                cancel_reason = reasoning or "AI determined no follow-up needed"

        # Thread-safe database insertion/update using its own thread connection
        with db_lock:
            thread_conn = get_db_connection(db_path)
            thread_cur = thread_conn.cursor()

            # Check if there is an existing draft for this contact
            thread_cur.execute("""
            SELECT id, status FROM followup_drafts
            WHERE contact = ?
            ORDER BY id DESC LIMIT 1
            """, (contact,))
            existing_row = thread_cur.fetchone()

            if existing_row and existing_row["status"] in ("PENDING", "CANCELLED"):
                draft_id = existing_row["id"]
                thread_cur.execute("""
                UPDATE followup_drafts
                SET drafted_msg = ?, reasoning = ?, intent = ?, status = ?, cancel_reason = ?,
                    decision = ?, category = ?, rule_ids = ?, internal_reason = ?,
                    required_human_action = ?, not_before = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """, (
                    followup_msg if status == "PENDING" else "",
                    reasoning,
                    intent,
                    status,
                    cancel_reason,
                    v2_decision,
                    category,
                    rule_ids_json,
                    internal_reason,
                    req_action,
                    not_before,
                    draft_id
                ))
            else:
                thread_cur.execute("""
                INSERT INTO followup_drafts (
                    contact, drafted_msg, reasoning, intent, status, cancel_reason,
                    decision, category, rule_ids, internal_reason, required_human_action, not_before,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """, (
                    contact,
                    followup_msg if status == "PENDING" else "",
                    reasoning,
                    intent,
                    status,
                    cancel_reason,
                    v2_decision,
                    category,
                    rule_ids_json,
                    internal_reason,
                    req_action,
                    not_before
                ))
                draft_id = thread_cur.lastrowid

            thread_conn.commit()
            thread_conn.close()

            processed_count += 1
            curr = processed_count

            if progress_callback:
                try:
                    progress_callback(curr, total_contacts, contact, status)
                except Exception:
                    pass

        return {
            "draft_id": draft_id,
            "contact": contact,
            "status": status,
            "decision": v2_decision,
            "followup_msg": followup_msg if status == "PENDING" else "",
            "reasoning": reasoning,
            "cancel_reason": cancel_reason,
            "rule_ids": rule_ids
        }

    # Execute in parallel using ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(process_single_contact, c_info) for c_info in contacts]
        for f in as_completed(futures):
            try:
                res = f.result()
                created_drafts.append(res)
            except Exception as e:
                # Log error and continue with remaining tasks
                pass

    return created_drafts
