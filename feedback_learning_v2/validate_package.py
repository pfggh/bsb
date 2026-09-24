#!/usr/bin/env python3
"""Validate package integrity, not model accuracy. No network or external libraries.
Usage: python validate_package.py [package_directory]
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

def read_jsonl(path: Path) -> list[dict[str, Any]]:
    result = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        obj = json.loads(line)
        if not isinstance(obj, dict):
            raise ValueError(f"{path.name}:{n}: expected JSON object")
        result.append(obj)
    return result

def validate(root: Path) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    def check(name: str, condition: bool, detail: str = "") -> None:
        checks.append({"check": name, "passed": bool(condition), "detail": detail})
    cards = read_jsonl(root / "feedback_learning_v2.jsonl")
    history = read_jsonl(root / "feedback_learning_enriched.jsonl")
    cases = read_jsonl(root / "regression_cases.jsonl")
    audit = json.loads((root / "source_audit.json").read_text(encoding="utf-8"))
    quarantine = json.loads((root / "quarantine.json").read_text(encoding="utf-8"))
    ids = {c["id"] for c in cards}
    hist = {r["source_record_id"]: r for r in history}
    spans = {**{q['source_record_id']:q['source_lines'] for q in quarantine}, **{i:r['source_lines'] for i,r in hist.items()}}
    check("canonical_card_count", len(cards) == audit["canonical_card_count"] == 64)
    check("unique_card_ids", len(ids) == len(cards))
    check("category_counts", dict(Counter(c["category"] for c in cards)) == audit["canonical_categories"])
    check("labeled_record_count", len(history) == audit["labeled_records"] == 978)
    check("unique_historical_ids", len(hist) == len(history))
    check("original_status_counts_preserved", dict(Counter(r["original_status"] for r in history)) == {k:v for k,v in audit["original_status_counts"].items() if k != "EMPTY"})
    check("all_source_rows_accounted", len(hist) + len(audit["empty_record_ids"]) == audit["id_bearing_records"] == 980)
    check("empty_rows_quarantined", set(audit["empty_record_ids"]) == {q["source_record_id"] for q in quarantine if q["reason"] == "EMPTY_PLACEHOLDER_NO_FEEDBACK_PAYLOAD"})
    check("corrupt_messages_preserved_only_as_history", all(hist[i]["suggested_professional_message"] is None and "CORRUPT_FINAL_MESSAGE_QUARANTINED" in hist[i]["quality_flags"] for i in audit["corrupt_final_message_record_ids"]))
    check("repaired_rows_retained", all("SPLIT_MARKDOWN_ROW_RECOVERED" in hist[i]["quality_flags"] for i in audit["repaired_record_ids"]))
    check("no_cancellation_rewritten_as_positive", all(r["suggested_professional_message"] is None for r in history if r["original_status"] == "CANCELLED"))
    check("card_content_hashes", all(hashlib.sha256(c["embedding_text"].encode()).hexdigest() == c["content_sha256"] for c in cards))
    check("no_old_embeddings_reused", all(c.get("embedding") is None for c in cards + history) and audit["fresh_embeddings_generated"] is False)
    check("all_history_has_expanded_reason", all(len(r["expanded_reason"].split()) >= 60 for r in history))
    check("provenance_separated_from_rewrite", all(r["expanded_reason_basis"] and r["mapping_basis"] and r["original_status"] for r in history))
    check("all_history_mappings_resolve", all(x in ids for r in history for x in r["canonical_rule_ids"]))
    check("source_pointers_resolve_exactly", all(ref['record_id'] in spans and ref['source_lines'] == spans[ref['record_id']] for c in cards for ref in c['source_records']))
    check("original_line_ranges_valid", all(1 <= s[0] <= s[1] <= audit["source_line_count"] for s in spans.values()))
    check("self_contained_cards", all(c["required_evidence"] and c["exclusions_and_near_misses"] and c["reason"] and c["retrieval_aliases"] and c["runtime_note"] for c in cards))
    check("regression_case_count", len(cases) == 96)
    check("unique_regression_ids", len({c["case_id"] for c in cases}) == len(cases))
    check("case_rules_resolve", all(x in ids for c in cases for x in c["relevant_rule_ids"]))
    check("every_card_has_fixture_coverage", {x for c in cases for x in c["relevant_rule_ids"]} == ids)
    check("non_send_fixture_messages_null", all(c["example_acceptable_message"] is None for c in cases if c["expected_decision"] != "SEND"))
    check("valid_fixture_decisions", all(c["expected_decision"] in {"SEND","SKIP","DEFER","HUMAN_REVIEW"} for c in cases))
    templates=[m for c in cards for values in c['preferred_messages'].values() for m in values]
    check("template_question_mark_limit", all(m.count('?') + m.count('\u061f') <= 1 for m in templates))
    check("canonical_templates_no_raw_urls_or_emails", not any(re.search(r'https?\s*:\s*//|www\.|[\w.+%-]+@[\w.-]+\.[A-Za-z]{2,}',m,re.I) for m in templates))
    blob='\n'.join(c['embedding_text'] for c in cards)
    check("canonical_retrieval_no_customer_phone_like_values", re.search(r'(?<!\w)\+?\d{7,}(?!\w)',blob) is None)
    history_blob='\n'.join(r['context_redacted']+' '+r['original_message_redacted']+' '+r['original_final_message_redacted'] for r in history)
    check("redacted_history_no_raw_urls_or_emails", re.search(r'https?\s*:\s*//|[\w.+%-]+@[\w.-]+\.[A-Za-z]{2,}',history_blob,re.I) is None)
    check("redacted_history_no_phone_like_values", re.search(r'(?<!\w)\+?\d{7,}(?!\w)',history_blob) is None)
    markdown=(root/'feedback_learning_v2.md').read_text(encoding='utf-8')
    check("markdown_has_all_cards", all(f"## {cid} - " in markdown for cid in ids))
    check("pinned_policy_present", len((root/'runtime_policy.txt').read_text(encoding='utf-8').split()) >= 150)
    return {"result":"PASS" if all(c['passed'] for c in checks) else "FAIL", "checks_passed":sum(c['passed'] for c in checks), "checks_total":len(checks), "checks":checks,
      "what_was_tested":"Local schema, record accounting, source-pointer consistency, hashes, fixture coverage and limited leakage/format checks.",
      "what_was_not_tested":"No live retrieval, embeddings, LLM behavior, semantic privacy audit, dispatch integration, WhatsApp delivery or business performance.",
      "regression_execution_status":"96 fixtures created and structurally checked; no production model predictions were supplied or graded."}

def main() -> None:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory',type=Path,nargs='?',default=Path(__file__).parent)
    args=parser.parse_args()
    try:
        result=validate(args.directory)
        text=json.dumps(result,indent=2)+'\n'
        (args.directory/'validation_report.json').write_text(text,encoding='utf-8')
        print(text,end='')
        if result['result']!='PASS':raise SystemExit(1)
    except (OSError,ValueError,KeyError,TypeError) as exc:
        parser.exit(2,f'Validation could not complete: {exc}\n')

if __name__=='__main__':main()
