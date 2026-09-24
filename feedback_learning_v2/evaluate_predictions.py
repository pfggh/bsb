#!/usr/bin/env python3
"""Evaluate actual pipeline outputs against the authored development fixtures.

No model is called and no message is sent. Python standard library only.

Usage:
  python evaluate_predictions.py predictions.jsonl --k 8 --out evaluation_report.json

Each prediction:
  {"case_id":"T001", "decision":"SEND", "message":"Are you still interested?",
   "retrieved_rule_ids":["SALES_01", "SALES_02"]}

Missing cases count as incorrect; unknown/duplicate case IDs are rejected.
Rule recall uses only fixture expected_retrieval_rule_ids, excluding always-on
policy-only requirements. Phrase checks are limited heuristics, not semantic QA.
"""
from __future__ import annotations
import argparse
import json
import re
from pathlib import Path
from typing import Any

VALID = {"SEND", "SKIP", "DEFER", "HUMAN_REVIEW"}

def load_jsonl(path: Path, key: str) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_number}: invalid JSON: {exc.msg}") from exc
            if not isinstance(obj, dict) or not isinstance(obj.get(key), str):
                raise ValueError(f"{path}:{line_number}: expected object with string {key}")
            if obj[key] in result:
                raise ValueError(f"{path}:{line_number}: duplicate {key} {obj[key]}")
            result[obj[key]] = obj
    return result

def ratio(n: int | float, d: int | float) -> float | None:
    return n / d if d else None

def message_issues(pred: dict[str, Any], fixture: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    decision, message = pred.get("decision"), pred.get("message")
    if decision not in VALID:
        issues.append("INVALID_DECISION")
    if decision != "SEND":
        if message is not None:
            issues.append("NON_SEND_MESSAGE_MUST_BE_NULL")
        return issues
    if not isinstance(message, str) or not message.strip():
        return issues + ["SEND_MESSAGE_MISSING"]
    if re.search(r"https?\s*:\s*//|www\.|\b[a-z0-9.-]+\.(?:com|xyz|net|org)(?:/|\b)", message, re.I):
        issues.append("URL_OR_DOMAIN_IN_MESSAGE")
    if re.search(r"[\w.+%-]+@[\w.-]+\.[A-Za-z]{2,}", message):
        issues.append("EMAIL_IN_MESSAGE_REQUIRES_BLOCK_OR_SEPARATE_AUTHORIZED_WORKFLOW")
    if "{" in message or "}" in message or re.search(r"\[(?:ACCOUNT|PHONE|CREDENTIAL|SECRET|ACCESS|IDENTIFIER)", message):
        issues.append("UNRESOLVED_PLACEHOLDER")
    if message.count("?") + message.count("\u061f") > 1:
        issues.append("MORE_THAN_ONE_QUESTION_MARK")
    if re.search(r"[\u0600-\u06ff]", message) and re.search(r"[A-Za-z]", message):
        issues.append("MIXED_SCRIPT_NEEDS_REVIEWED_EXCEPTION")
    if re.search(r"\b(?:we(?:'re| are| will| have)|i(?:'m| am| will| have))\s+(?:now\s+)?(?:fix|activat|refund|cancel|replac|send|check)", message, re.I):
        issues.append("POSSIBLE_UNAUTHORIZED_OPERATIONAL_CLAIM")
    if re.search(r"\b(?:completely unlimited|zero limits|last chance|guaranteed no issues)\b", message, re.I):
        issues.append("POSSIBLE_UNSUPPORTED_CLAIM_OR_PRESSURE")
    for name in ("contact_allowed", "channel_eligible", "cadence_due", "recipient_matches", "conversation_unchanged"):
        if fixture["trusted_state"].get(name) is not True:
            issues.append(f"SEND_WITH_UNPASSED_{name.upper()}")
    if fixture["trusted_state"].get("duplicate_pending") is True:
        issues.append("SEND_WITH_DUPLICATE_PENDING")
    return issues

def evaluate(fixtures: dict[str, dict[str, Any]], predictions: dict[str, dict[str, Any]], k: int) -> dict[str, Any]:
    extra = set(predictions) - set(fixtures)
    if extra:
        raise ValueError(f"Unknown case IDs: {', '.join(sorted(extra))}")
    correct = true_send = predicted_send = expected_send = false_send = reviews_on_send = 0
    retrieval_sum = retrieval_cases = logged_retrieval_cases = 0
    total_retrieved = 0
    failures: list[dict[str, Any]] = []
    violations: list[dict[str, Any]] = []
    missing: list[str] = []
    for cid, fixture in fixtures.items():
        pred = predictions.get(cid)
        expected = fixture["expected_decision"]
        expected_send += expected == "SEND"
        if pred is None:
            missing.append(cid)
            failures.append({"case_id": cid, "expected": expected, "actual": "MISSING"})
        else:
            actual = pred.get("decision")
            correct += actual == expected
            predicted_send += actual == "SEND"
            true_send += actual == expected == "SEND"
            false_send += actual == "SEND" and expected != "SEND"
            reviews_on_send += actual == "HUMAN_REVIEW" and expected == "SEND"
            if actual != expected:
                failures.append({"case_id": cid, "expected": expected, "actual": actual})
            issues = message_issues(pred, fixture)
            if issues:
                violations.append({"case_id": cid, "issues": issues})
        expected_rules = set(fixture.get("expected_retrieval_rule_ids", []))
        if expected_rules:
            retrieval_cases += 1
            raw = pred.get("retrieved_rule_ids", []) if pred else []
            if not isinstance(raw, list) or any(not isinstance(x, str) for x in raw):
                raise ValueError(f"{cid}: retrieved_rule_ids must be an array of strings")
            logged_retrieval_cases += pred is not None and "retrieved_rule_ids" in pred
            retrieved = list(dict.fromkeys(raw))[:k]
            total_retrieved += len(retrieved)
            retrieval_sum += len(expected_rules & set(retrieved)) / len(expected_rules)
    return {
        "evaluation_type": "ACTUAL_INPUT_PREDICTIONS_ON_AUTHORED_DEVELOPMENT_FIXTURES",
        "fixture_count": len(fixtures), "prediction_count": len(predictions),
        "missing_predictions": missing, "decision_accuracy_all_fixtures": ratio(correct, len(fixtures)),
        "valid_followup_recall": ratio(true_send, expected_send),
        "send_precision": ratio(true_send, predicted_send), "false_send_count": false_send,
        "expected_send_count": expected_send, "predicted_send_count": predicted_send,
        "unnecessary_review_rate_among_expected_sends": ratio(reviews_on_send, expected_send),
        "retrieval_k": k,
        "mean_labeled_rule_recall_at_k_including_missing_logs_as_zero": ratio(retrieval_sum, retrieval_cases),
        "retrieval_log_coverage": ratio(logged_retrieval_cases, retrieval_cases),
        "mean_retrieved_count_on_retrieval_cases": ratio(total_retrieved, retrieval_cases),
        "decision_failures": failures, "limited_message_check_violations": violations,
        "limitations": [
            "Fixtures are proposed development labels, not independent held-out ground truth.",
            "Decision matches do not prove that a customer message is factual or appropriate.",
            "Word/format checks are incomplete heuristics and can miss semantic violations.",
            "No live API, embedding service, customer conversation or dispatch gate is accessed.",
            "Null metrics mean no relevant denominator; they are not zero or perfect scores.",
        ],
    }

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("predictions", type=Path)
    parser.add_argument("--cases", type=Path, default=Path(__file__).with_name("regression_cases.jsonl"))
    parser.add_argument("--k", type=int, default=8)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if args.k < 1:
        parser.error("--k must be positive")
    try:
        report = evaluate(load_jsonl(args.cases, "case_id"), load_jsonl(args.predictions, "case_id"), args.k)
        rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        if args.out:
            args.out.write_text(rendered, encoding="utf-8")
        print(rendered, end="")
    except (OSError, ValueError, KeyError) as exc:
        parser.exit(2, f"Error: {exc}\n")

if __name__ == "__main__":
    main()
