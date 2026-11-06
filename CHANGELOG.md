# Changelog

## 0.1.0 (2026-11-06)

Initial release.

- **ServiceNow Advanced Trigger**
  - *On Flow Designer Call*: registers an interface that Flow Designer flows call.
  - *On Record Change*: watches a table for inserts and updates matching a condition, with a table picker and a condition builder.
- **ServiceNow Advanced**
  - *Request an approval*, *Ask a question* (all nine question types) and *Report an error* as human-in-the-loop requests.
  - Optionally waits for the decision or answers, with one output per outcome (approved / rejected, answered / declined, expired / other).
  - Usable as an AI agent tool, with an approval gate for other tools (Human review).
  - Pickers for assignment group, related record table and record; files can be attached to the related record; each request links back to the n8n run.
- Condition builder with operators per field type and a list of choice values.
- OAuth2 and Basic Auth credentials. The Basic Auth test checks the API role, and a missing role is named in errors.
