# Start here: feedback_learning v2

## The files to use

**For a vector database:** ingest `feedback_learning_v2.jsonl`. It contains 64 canonical, conditional rule cards. Embed only each row's `embedding_text`, retain its structured fields as payload, and keep `id` and `version` as metadata. The `reason` field contains the expanded reusable explanation.

**For a document-based knowledge uploader:** use `feedback_learning_v2.md`, the readable equivalent with an operating guide. Keep each rule's conditions, reason and exclusions together when chunking. Do not also index the equivalent JSONL; that duplicates the same knowledge.

**Always-on instructions:** include `runtime_policy.txt` in the model's instruction context. The important boundaries must not depend on a lucky similarity match. The application, not the model, must verify actual recipient, cadence, suppression, channel eligibility, duplicate state and conversation freshness before any send.

**For the expanded historical rows:** `feedback_learning_enriched.jsonl` contains all 978 labeled records with original statuses, redacted source context and feedback, expanded reasons, conditional professional-message proposals, source pointers and quality flags. It is an audit/review dataset, not the recommended default retrieval corpus. Mapping and interpretation fields explicitly distinguish manual curation from heuristic assignment. Generic original reasons are not silently promoted into explicit owner policy.

## What was changed

The knowledge now separates open sales, answered choices, missing product details, relevant alternatives, final attempts, payment states, delivered remedies, acknowledgements, closure, dormant access reminders, unspecified failures, human-owned work and media uncertainty. It retains English and short Lebanese Arabizi instead of turning every message into corporate English. Customer messages remain short; the internal explanations carry the detail.

Historical outcomes are not rewritten. New candidate messages are proposals, not newly approved historical responses. The source does not establish a current product catalogue, a numerical sending cadence or a verified database schema. Current factual placeholders must be supplied by the application from approved data; literal placeholders must never be sent.

## Processing account

- Original ID-bearing rows: 980; labeled: 978; empty placeholders: 2.
- Original outcomes: 800 APPROVED, 79 MODIFIED, 99 CANCELLED.
- Recovered split rows: 1803 and 1828. Empty rows: 2343 and 2344.
- Quarantined final-message values: record 1389 (one character) and 1935 (a phone number).
- Conditional professional rewrite proposals in the historical review file: 816.
- Canonical cards: 24 sales, 20 support, 16 guardrails, four style.
- Original embeddings: 978 vectors of 1536 dimensions. Model/version not supplied. Old vectors are intentionally not included or reused.

`source_audit.json` includes the original file hash, detailed flags and caveats. `quarantine.json` records empty/corrupt payloads. Source row IDs and line ranges remain available for checking the original upload. The original upload itself is not modified or included in this bundle.

## Deployment sequence

1. Preserve the existing corpus and index for rollback. Treat this normalized package as a new version, not as a direct overwrite of the production table.
2. Generate fresh embeddings for canonical `embedding_text` with the same compatible model/version and dimensions used for the new query embeddings. Load a new namespace. Keep the short runtime policy always present. No embeddings or remote changes were performed here.
3. Run your actual retriever and model on the supplied development cases and independently reviewed held-out chats. Inspect false sends and missed valid follow-ups. Switch over only after owner review and application-gate testing.

An importer must map this package to your actual storage contract. The original Markdown has no verified SQL headers or production schema, so there is no speculative destructive SQL migration in the bundle. Merely replacing text while keeping old embeddings does not create the intended new retrieval representation.

## Testing utilities

`regression_cases.jsonl` contains 96 authored development cases covering all 64 cards. These are not new customer chats or independently verified benchmark labels. They include minimal pairs for thanks, reactions, first/final sales messages, repeated support checks, promises versus completion, missing media, payment, actual service, style and dispatch gates.

Validate local integrity:

```bash
python validate_package.py
```

The supplied run passed 32 of 32 local checks. These verify JSON structure, record accounting, exact source-pointer consistency, content hashes, rule references, fixture coverage and limited redaction/format checks. They do not prove live model accuracy.

To evaluate your own pipeline, create a predictions JSONL with one row per case:

```json
{"case_id":"T001","decision":"SEND","message":"Are you still interested?","retrieved_rule_ids":["SALES_01","SALES_02"]}
```

Then run:

```bash
python evaluate_predictions.py predictions.jsonl --k 8 --out evaluation_report.json
```

The evaluator reports exact decision accuracy, valid-follow-up recall, send precision, false sends, unnecessary reviews and labeled retrieval-rule recall at K. Missing predictions are not hidden; missing retrieval logs count as zero in the named overall retrieval metric and log coverage is reported. Always-on policy-only cases are excluded from the retrieval denominator. Phrase checks are intentionally limited and require human semantic review, especially for facts, tone, current context and hidden assumptions.

No production predictions were supplied, so the 96 cases have not been passed by your bot. The evaluator itself was checked with synthetic unit inputs solely to verify metric bookkeeping and input validation; those are not bot performance results.

## Feedback collection going forward

For each new review, retain a sanitized state snapshot, original draft, final human wording, original decision, corrected decision if any, the specific reason, reviewer authority, relevant rule ID, current catalogue version, conversation version, and whether the correction concerns eligibility, factual accuracy, wording, timing or capability. Keep opt-outs and live task data in their authoritative operational stores, not in similarity examples.

Do not let an automatically generated reason masquerade as the reviewer's own explanation. An owner approving punctuation does not thereby approve a universal send rule. A human operational message does not expand bot permissions. Positive recall examples and negative boundaries must both remain retrievable.

## Privacy and limitations

The canonical cards do not contain customer-specific payloads. Historical review text is pattern-redacted and remains restricted data; this is not a formal anonymity certification. Do not publish the historical file, treat it as a public training set, or copy historical fields into current customer messages. Use current trusted routing metadata only.

This package improves the knowledge design and makes its decisions testable. It cannot by itself guarantee perfect recall, perform human account work, enforce WhatsApp/channel permissions, configure your sending schedule or prevent every model error. Application integration and real evaluation remain necessary.
