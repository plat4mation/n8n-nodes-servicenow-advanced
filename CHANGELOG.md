# Changelog

## 0.1.1 (2026-11-06)

- No functional changes.

## 0.1.0 (2026-11-06)

- **ServiceNow Advanced Trigger**
  - *On Flow Designer Call*: registers an interface that Flow Designer flows call.
  - *On Record Change*: watches a table for inserts and updates matching a condition, with a table picker and a condition builder.
- **ServiceNow Advanced**
  - *Request an approval*, *Ask a question* (all nine question types) and *Report an error* as human-in-the-loop requests.
  - Optionally waits for the decision or answers, with one output per outcome (approved / rejected, answered / declined, expired / other).
  - *Get Decision*, *Cancel Request* and *Add Work Note* for existing requests.
  - Usable as an AI agent tool, with an approval gate for other tools (Human review).
  - Pickers for assignment group, related record table and record; files can be attached to the related record; each request links back to the n8n run.
- Condition builder with operators per field type and a list of choice values.
- **Record actions**: Search Records, Create or Update (match on fields, skips unchanged), Compare Record (JSON and Markdown diff), Bulk Create or Update (Batch API), Aggregate Records, Get Record With Context (optionally with the attachments as binary data), Evaluate Condition (True / False outputs).
- **Order Catalog Item** and **Search Knowledge**.
- **Wait for Record**: pause a workflow until a record on a watch table matches a condition, with Matched and Timed Out outputs.
- OAuth2 and Basic Auth credentials. The Basic Auth test checks the API role, and a missing role is named in errors.
