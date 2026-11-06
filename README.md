# @plat4mation/n8n-nodes-servicenow-advanced

This is an n8n community node package. It connects n8n to the `x_pl4_n8n` and `x_pl4_hitl` ServiceNow apps, so ServiceNow can start and resume n8n workflows.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation)
[Nodes](#nodes)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Development](#development)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

The ServiceNow instance needs the `x_pl4_n8n` scoped app, and the ServiceNow user in the credential needs the `x_pl4_n8n.api` role.

ServiceNow calls n8n at the credential's **n8n Base URL** (for example an API gateway route) plus the webhook path. Leave it empty to use n8n's own webhook URL.

## Nodes

The package has two nodes that appear together as **ServiceNow Advanced** in the node panel.

### ServiceNow Advanced Trigger

**Event: On Flow Designer Call** starts a workflow when a ServiceNow Flow Designer flow calls its n8n interface.

- When the workflow is activated, the node registers an interface in ServiceNow under the chosen **Interface Identifier** (lowercase snake_case, at most 40 characters). Flows select the interface by that identifier.
- The node outputs the flow's payload fields directly (`$json.<field>`); ServiceNow's envelope (`correlation_token`, `callback_url`, …) is under `_servicenow`.
- **Expected Payload** describes what the flow sends, either as a list of fields (name, type and example value) or as a JSON object. Its top-level keys become the inputs of the Flow Designer action.
- When the workflow is deactivated, the interface record is kept by default, so flows keep referencing it. Set **On Deactivation** to *Delete Interface* to remove it instead.
- Test and live runs use the same interface record. "Listen for test event" temporarily points it at the editor's test URL, so calls from ServiceNow, including live ones, go to the editor while you test. When the test ends, it is pointed back at the live workflow if that is active.

**Event: On Record Change** starts a workflow when a record in a ServiceNow table is inserted or updated and matches an encoded query.

- **Table**: pick from the list or enter a name. The list shows `task`, `sys_user`, `x_pl4_hrlifecycle4_lifecycle_user` and every table that extends them (read from `sys_db_object`).
- **Trigger On**: Insert, Update or Insert or Update.
- **Condition**: build it with the **condition builder**, or paste an **encoded query**. In the builder, each row has a field (including inherited fields), operators that fit the field's type, and a **Value** list with the stored values of choice and true/false fields; pick *Custom Value…* to type any other value. Rows combine with AND / OR / new query. Operators include the change operators *Changes*, *Changes From* and *Changes To* (VALCHANGES, CHANGESFROM, CHANGESTO). No conditions triggers on every insert/update.
- The table list needs read access to `sys_db_object`. Fields come from ServiceNow's UI metadata API (`/api/now/ui/meta/<table>`, needs read access to the table) with `sys_dictionary` as fallback. Without access, enter the table by name and use the encoded query.
- Output: `{ table, sys_id, operation, record }`, plus `_servicenow` with the envelope.
- Registration, testing and deactivation work as for Flow Designer: one interface per **Interface Identifier**.

### ServiceNow Advanced

Creates a human-in-the-loop (HITL) request in ServiceNow through the `x_pl4_hitl` app. Actions:

- **Request an approval**: a group approves or rejects.
- **Ask a question**: a group answers questions. Build them with fields (ID, label, type, mandatory, help text, and only the limits that fit the type) or paste them as JSON.
- **Report an error**: a group fixes a problem on a related record. Needs the error message and the related record (table plus number or sys_id). Send and forget only: ServiceNow never pushes error decisions back.

Shared fields: subject and the context shown to the reviewer (fields or JSON). Under **Options**:
- **Assignment Group**: pick from the list or type a name or sys_id.
- **Related Record**: pick the table and the record from lists, or type the record's number or sys_id. Required for Report an error.
- **Attachments (Binary Fields)**: binary fields of the input item (e.g. `data, invoice`) uploaded to the related record before the request is created; the file names are added to the context.
- **Include Link to Workflow Run** (on by default): adds the workflow name and a link to this n8n execution to the context.
- **Expires At** and **Stop Waiting After (Hours)**.

The node can be used in three ways:

| Use | Approval / Ask | Report Error |
|---|---|---|
| Workflow step | Sends; with **Wait for Completion** on, pauses until the decision or answers come back | Sends |
| AI agent tool | Sends and returns the `correlation_id` (a tool call can't pause) | Sends |
| **Human review** (approval only) | Attach *ServiceNow Advanced (Human review)* to an AI Agent's tools and put other tools under it. When the agent wants to run one of those tools, the approval is requested in ServiceNow; the tool only runs once approved. A rejection comment is passed to the agent as feedback | — |

**Wait for Completion** sends ServiceNow this node's resume URL, including its `?signature=` token. The decision ServiceNow posts back becomes the node's output:

```json
{
  "correlation_id": "a3f9c1e84b2d47f0a91c5e6d2b7f8340",
  "outcome": "approved",
  "approved": true,
  "comments": null,
  "resolved_by": "jane.doe@example.com",
  "resolved_at": "2026-11-05T10:15:00Z",
  "related_record": { "table": "incident", "sys_id": "…", "display_value": "INC0012345" }
}
```

While waiting, the node has one output per outcome, so you can branch without an IF node:

| Action | Output 1 | Output 2 | Output 3 |
|---|---|---|---|
| Request an approval | Approved | Rejected | Expired / Other |
| Ask a question | Answered | Declined | Expired / Other |

*Expired / Other* receives expired requests, waits that timed out in n8n (also how a cancelled request ends) and retries of a request that was already settled. Without waiting, as an AI tool and as the Human review gate, the node has a single output.

`outcome` is `approved`, `rejected`, `answered`, `declined` or `expired`. Request an approval adds `approved`; Ask a question adds `answers` (the answers keyed by question ID) instead. When the request has an expiry, n8n stops waiting 15 minutes after it; without one it stops after **Stop Waiting After (Hours)** (default 168). Either way the output has the same keys with `outcome: "timed_out"`. ServiceNow never pushes cancelled requests, so a cancellation also ends as `timed_out`. A callback that isn't a `hitl_decision` gets a 400 and the workflow keeps waiting. Only the first input item is processed while waiting. The callback is protected by the secret token in the resume URL.

Without waiting, every input item creates one request and the output holds its `correlation_id`.

### ServiceNow Advanced: records, catalog and knowledge

Besides human review, the node has these actions on standard ServiceNow APIs (all usable as AI agent tools):

| Resource | Action | What it does |
|---|---|---|
| Record | **Search Records** | Find records with the condition builder or an encoded query; choose fields, order, display values, return all or a limit. |
| Record | **Create or Update** | Match on one or more fields: no match creates, a match updates. Several matches fail (or update all / the first). Unchanged records are skipped, so no business rules or audit entries run for nothing. Output `action`: created / updated / unchanged, plus the changes. Fields ServiceNow didn't save (no write access) are listed in `not_saved` with a warning. |
| Record | **Compare Record** | Compare proposed values with a record (by sys_id or match fields). Returns `changes` as JSON and a `markdown` table (*Field \| Current \| Proposed*) with labels and display values, e.g. for an approval's context. |
| Record | **Bulk Create or Update** | All input items in a few Batch API calls. One result per item with `success`; without *Continue On Fail* any failure stops the node. |
| Record | **Aggregate Records** | Count, sum, average, minimum, maximum, grouped by fields (Aggregate API). One item per group. |
| Record | **Get Record With Context** | A record plus its latest comments and work notes, attachment list and related lists. **Download Attachments** adds the files as binary data (`attachment_0`, `attachment_1`, …) for other nodes. Parts the user can't read become `warnings`. |
| Record | **Evaluate Condition** | Check whether a record (by sys_id) matches a condition (builder or encoded query). The input item goes to the **True** or **False** output unchanged, like an If node. ServiceNow evaluates the query itself, so every operator works except the change operators. A record that doesn't exist or can't be read is an error, not False. As an AI tool it returns `matches`. |
| Record | **Wait for Record** | See below. |
| Service Catalog | **Order Catalog Item** | Order an item with its variables (picked from the item), so its flows and approvals run. Returns the REQ and its RITMs. |
| Knowledge | **Search Knowledge** | Search knowledge articles, optionally with the article text. Uses the Knowledge Management REST API; without that plugin it searches published articles through the Table API (`kb_knowledge`, keyword search, `source: "table_api"`). |

When the ServiceNow user can't read `sys_journal_field`, Get Record With Context reads the comments and work notes from the record itself; `created_by` is then the user's name and `created_on` is in that user's date format.

"Values Are Display Values" lets Create or Update and Bulk accept display values (e.g. a group name) for ServiceNow to resolve.

### ServiceNow Advanced: Wait for Record

**Wait for Record** (resource *Record*) pauses the workflow until a record on a watch table is inserted or updated and matches a condition (same table picker and condition builder as the trigger).

- **Only This Record (Sys ID)**: wait for one record, e.g. the one that started the workflow; leave empty for any matching record.
- **Continue If Already Matching** (on by default): if a record already matches, the workflow continues right away. Skipped for change operators (*Changes*, *Changes From*, *Changes To*), which only exist during a save.
- **Stop Waiting After (Hours)** (default 24).
- Outputs: **Matched** with `{ matched, table, sys_id, operation, record }`, or **Timed Out**.

While waiting, a temporary `watch_trigger` interface named `n8n_wait_…` exists in ServiceNow. It is removed when the record matches; after a time-out it is removed by the next Wait for Record registration. Not available as an AI agent tool, because a tool call can't pause.

## Credentials

Each node has an **Authentication** option: **OAuth2** (default) or **Basic Auth**.

### OAuth2

1. In ServiceNow, create an OAuth application endpoint for external clients (**System OAuth > Application Registry**).
2. In n8n, create a **ServiceNow Advanced OAuth2 API** credential and fill in the instance URL (for example `https://dev12345.service-now.com`), client ID and client secret.
3. For the authorization code grant, copy the OAuth redirect URL from n8n into the application's **Redirect URL** in ServiceNow.

An existing OAuth application used by n8n's built-in ServiceNow node can be reused.

### Basic Auth

Create a **ServiceNow Advanced Basic Auth API** credential with the instance URL and the username and password of an integration user. n8n tests the credential by reading that user's own `sys_user` record.

### Extra credential fields

- **n8n Base URL**: public base URL ServiceNow uses to call n8n (for example an API gateway route). Empty uses n8n's own URL.
- **HITL Requester System**: code of the `x_pl4_hitl_tool` record for this n8n environment (for example `n8n_dev`). Required by the approval, question and error nodes. The ServiceNow user needs the `x_pl4_hitl.api` and `snc_internal` roles.

## Compatibility

Tested against n8n 2.x.

## Development

```bash
npm install
npm run lint
npm run build
npm run dev:tunnel   # n8n with this package loaded, behind a public HTTPS tunnel
```

ServiceNow can only call n8n over a public HTTPS URL. `npm run dev:tunnel` starts a Cloudflare quick tunnel (`brew install cloudflared`); point the n8n base URL in ServiceNow at the tunnel URL it prints. The URL changes on every run.

## License

[MIT](LICENSE). Created by Luc Raeskin for [Plat4mation](https://www.plat4mation.com).
