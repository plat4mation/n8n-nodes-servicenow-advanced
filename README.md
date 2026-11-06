# @plat4mation/n8n-nodes-servicenow-advanced

This is an n8n community node package for ServiceNow. It lets ServiceNow start and resume n8n workflows, puts people in the loop through ServiceNow reviews, and adds record, catalog and knowledge actions that go beyond plain create/read/update.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation)
[Requirements in ServiceNow](#requirements-in-servicenow)
[Nodes and actions](#nodes-and-actions)
[ServiceNow Advanced Trigger](#servicenow-advanced-trigger)
[ServiceNow Advanced](#servicenow-advanced)
[Use with AI agents](#use-with-ai-agents)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Development](#development)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

## Requirements in ServiceNow

| Used by | ServiceNow app or API | Roles for the ServiceNow user in the credential |
|---|---|---|
| Trigger, Wait for Record | `x_pl4_n8n` scoped app (interface API) | `x_pl4_n8n.api` |
| Human Review actions | `x_pl4_hitl` scoped app (HITL API) | `x_pl4_hitl.api` and `snc_internal` |
| Record actions | Standard Table, Batch, Aggregate, Attachment and UI metadata APIs | Read (and write) access to the tables you use |
| Order Catalog Item | Service Catalog REST API | Access to order the item |
| Search Knowledge | Knowledge Management REST API, or the Table API on `kb_knowledge` | Read access to the articles |

ServiceNow calls n8n (triggers, resumed waits) at the credential's **n8n Base URL**, for example an API gateway route, plus the webhook path. Leave it empty to use n8n's own webhook URL. Either way the URL must be reachable from ServiceNow over HTTPS.

## Nodes and actions

The package has two nodes that appear together as **ServiceNow Advanced** in the node panel.

| Node | Resource | Action | Purpose |
|---|---|---|---|
| ServiceNow Advanced Trigger | | On Flow Designer Call | Start a workflow from a ServiceNow Flow Designer flow |
| ServiceNow Advanced Trigger | | On Record Change | Start a workflow when a record is inserted or updated and matches a condition |
| ServiceNow Advanced | Human Review | Request Approval | Let a group approve or reject something, optionally waiting for the decision |
| ServiceNow Advanced | Human Review | Ask Question | Let a group answer questions (nine answer types), optionally waiting for the answers |
| ServiceNow Advanced | Human Review | Report Error | Hand a problem on a record to a group to fix |
| ServiceNow Advanced | Human Review | Get Decision | Read the current outcome of a request |
| ServiceNow Advanced | Human Review | Cancel Request | Withdraw an open request |
| ServiceNow Advanced | Human Review | Add Work Note | Add a note for the reviewers to an open request |
| ServiceNow Advanced | Record | Search Records | Find records with a condition |
| ServiceNow Advanced | Record | Create or Update | Create a record, or update it when it already exists (upsert) |
| ServiceNow Advanced | Record | Compare Record | Show what would change on a record, as JSON and as a Markdown table |
| ServiceNow Advanced | Record | Bulk Create or Update | Write many records in a few Batch API calls |
| ServiceNow Advanced | Record | Aggregate Records | Count, sum, average, minimum or maximum, optionally grouped |
| ServiceNow Advanced | Record | Get Record With Context | A record with its comments, work notes, attachments and related lists |
| ServiceNow Advanced | Record | Evaluate Condition | Route an item to True or False depending on whether a record matches a condition |
| ServiceNow Advanced | Record | Wait for Record | Pause the workflow until a record matches a condition |
| ServiceNow Advanced | Service Catalog | Order Catalog Item | Order a catalog item, so its own flows and approvals run |
| ServiceNow Advanced | Knowledge | Search Knowledge | Find published knowledge articles, optionally with their text |

Every action of ServiceNow Advanced except Wait for Record can also be used as an AI agent tool; see [Use with AI agents](#use-with-ai-agents).

## ServiceNow Advanced Trigger

Both events register an **interface** in ServiceNow when the workflow is activated. The interface tells ServiceNow where to call n8n.

- **Interface Identifier**: lowercase snake_case, at most 40 characters. One identifier is one interface record; test and live runs share it.
- **Listen for test event** temporarily points the interface at the editor's test URL, so calls from ServiceNow, including live ones, go to the editor while you test. When the test ends, it points back at the live workflow if that is active.
- **On Deactivation**: *Keep Interface* (default) leaves the record in ServiceNow, so flows keep referencing it; *Delete Interface* removes it.
- The output contains the data ServiceNow sends; ServiceNow's envelope (`correlation_token`, `callback_url`, …) is under `_servicenow`.

### On Flow Designer Call

Starts the workflow when a Flow Designer flow calls the interface. Use it to hand work from a ServiceNow flow to n8n.

- **Expected Payload**: what the flow sends, as a list of fields (name, type, example value) or as a JSON object. Its top-level keys become the inputs of the Flow Designer action.
- Output: the payload fields directly (`$json.<field>`).

### On Record Change

Starts the workflow when a record in a table is inserted or updated and matches a condition. ServiceNow pushes the change; n8n does not poll.

- **Table**: the list shows `task`, `sys_user`, `x_pl4_hrlifecycle4_lifecycle_user` and every table that extends them. Tables hidden from the user's table list can be typed by name.
- **Trigger On**: Insert, Update, or Insert or Update.
- **Condition**: the [condition builder](#condition-builder) or an encoded query. Change operators (*Changes*, *Changes From*, *Changes To*) are supported. No condition triggers on every insert or update.
- Output: `{ table, sys_id, operation, record }`.

## ServiceNow Advanced

### Human Review

Human Review actions create and follow up on reviews in the `x_pl4_hitl` app. A review is a task in ServiceNow for an assignment group; the reviewer's decision can come back into the workflow.

#### Request Approval

A group approves or rejects something, for example a purchase, an access request or an AI agent's proposed action. Turn on **Wait for Completion** to pause the workflow until the decision comes back.

#### Ask Question

A group answers questions, for example missing data the workflow needs. Define the questions with fields (ID, label, type, mandatory, help text, default answer and only the limits that fit the type) or paste them as JSON. Answer types: string, text, integer, decimal, boolean, choice, multi choice, date and date/time. Turn on **Wait for Completion** to pause until the answers come back; they are in `answers`, keyed by question ID.

#### Report Error

Hands a problem on a record to a group to fix, for example a failed integration step. Needs the error message and the related record (table plus number or sys_id); error code, failed step and details are optional. The workflow does not wait: read the outcome (`resolved` or `abandoned`) later with **Get Decision**.

#### Fields shared by these three actions

- **Subject**: short description of the review.
- **Context**: what the reviewer sees, as fields or JSON.
- **Options**:
  - **Assignment Group**: pick from the list or type a name or sys_id. Without it, the requester system's default group is used.
  - **Related Record**: the record the review is about; pick the table and the record or type its number or sys_id. Required for Report Error.
  - **Attachments (Binary Fields)**: binary fields of the input item (e.g. `data, invoice`) that are uploaded to the related record before the request is created; the file names are added to the context.
  - **Include Link to Workflow Run** (on by default): adds the workflow name and a link to the n8n execution to the context.
  - **Expires At** and **Stop Waiting After (Hours)**.

#### Waiting for the decision

With **Wait for Completion** on, the node sends ServiceNow its resume URL (with its `?signature=` token) and pauses. While waiting, it has one output per outcome, so you can branch without an If node:

| Action | Output 1 | Output 2 | Output 3 |
|---|---|---|---|
| Request Approval | Approved | Rejected | Expired / Other |
| Ask Question | Answered | Declined | Expired / Other |

Output of a decision:

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

- `outcome` is `approved`, `rejected`, `answered`, `declined`, `expired` or `timed_out`. Request Approval adds `approved`; Ask Question adds `answers`.
- With an expiry, n8n stops waiting 15 minutes after it; without one, after **Stop Waiting After (Hours)** (default 168). A timeout gives `outcome: "timed_out"` on *Expired / Other*. A cancelled request also ends this way, because ServiceNow doesn't push cancellations.
- A retry of a request that was already decided goes to *Expired / Other* right away.
- Only the first input item is processed while waiting. A callback that isn't a `hitl_decision` gets a 400 and the workflow keeps waiting.

Without waiting, every input item creates one request and the output holds its `correlation_id`; use it with the actions below.

#### Get Decision

Reads the current outcome of a request by its **Correlation ID**. Use it for Report Error, for requests sent without waiting, or to check on a request from another workflow.

- `outcome`: `open` while nobody has decided, otherwise `approved`, `rejected`, `answered`, `declined`, `resolved`, `abandoned`, `expired` or `cancelled`.
- The output always has the same keys: `correlation_id`, `outcome`, `approved` (approvals, else `null`), `answers` (answered questions, else `null`), `comments`, `resolved_by`, `resolved_at`, `related_record`.

#### Cancel Request

Withdraws an open request by its **Correlation ID**, with an optional **Reason** that is stored as the review's closing comment. Cancelling again returns `already_cancelled: true`. A request that is already decided or expired gives an error.

#### Add Work Note

Adds a **Work Note** (at most 4000 characters) to the open review of a request, for example to tell the reviewers that a retry is scheduled. Work notes are for reviewers only and are never sent back with the decision. A request without an open review gives an error.

### Record

Record actions work on any table the ServiceNow user can access, through the standard ServiceNow APIs. Pick the **Table** from the list or type its name.

#### Search Records

Finds records with the [condition builder](#condition-builder) or an encoded query. Choose the fields to return, the order, whether to return stored values, display values or both, and return all matches or a limit. One item per record.

#### Create or Update

Creates a record, or updates the existing one (upsert). **Match On** names the fields that identify the record.

- No match creates; one match updates. With several matches the node fails by default, or updates all of them or only the first (**If Several Records Match**).
- **Skip Unchanged** (on by default): a record whose values are already the same is not written, so no business rules or audit entries run for nothing.
- **Values Are Display Values**: send display values (e.g. a group name) for ServiceNow to resolve.
- Output: `action` (`created`, `updated` or `unchanged`), `sys_id`, the changes and the record. Fields ServiceNow didn't save, for example because the user may not write them, are listed in `not_saved` with a warning.

#### Compare Record

Compares proposed values with a record (found by sys_id or by match fields) without changing anything. Returns `changes` as JSON and a `markdown` table (*Field | Current | Proposed*) with field labels and display values, for example to show in an approval's context. Stored and display values count as equal.

#### Bulk Create or Update

Creates or updates all input items in a few Batch API calls instead of one call per item. **Batch Size** sets the items per call. One result per item with `success`; without *Continue On Fail*, any failure stops the node. Fields that weren't saved are reported as in Create or Update.

#### Aggregate Records

Counts records, or computes the sum, average, minimum or maximum of fields, for the records that match a condition, optionally grouped by fields. One item per group.

#### Get Record With Context

Reads one record by sys_id together with what a person or an AI agent needs to understand it:

- **Journal Entries**: the latest comments and work notes. When the user can't read `sys_journal_field`, they are read from the record itself; `created_by` is then the person's name and `created_on` is in the user's date format.
- **Include Attachments List**: file names, sizes and download links.
- **Download Attachments**: adds the files as binary data (`attachment_0`, `attachment_1`, …) for other nodes; each list entry names its `binary_property`.
- **Related Lists**: records from other tables that reference this one.

Parts the user can't read become `warnings` instead of failing the node.

#### Evaluate Condition

Checks whether a record (by sys_id) matches a condition and routes the input item, unchanged, to the **True** or **False** output, like an If node. ServiceNow evaluates the encoded query itself, so every operator behaves exactly as in a list filter. A record that doesn't exist or can't be read is an error, not False. Change operators are not allowed, because they only exist while a record is saved. As an AI tool it returns `{ matches }`.

#### Wait for Record

Pauses the workflow until a record on a watch table is inserted or updated and matches a condition, for example until a task is closed. Same table list and condition builder as the On Record Change trigger.

- **Only This Record (Sys ID)**: wait for one record, e.g. the one that started the workflow; leave empty for any matching record.
- **Continue If Already Matching** (on by default): if a record already matches, the workflow continues at once. Not checked for change operators.
- **Stop Waiting After (Hours)** (default 24).
- Outputs: **Matched** with `{ matched, table, sys_id, operation, record }`, or **Timed Out**.

While waiting, a temporary interface named `n8n_wait_…` exists in ServiceNow. It is removed when the record matches; after a timeout, the next Wait for Record removes it.

### Service Catalog

#### Order Catalog Item

Orders a catalog item as the ServiceNow user, so the item's own flows, approvals and fulfilment run. Pick the item, then fill in its **Variables** (picked from the item, mandatory ones marked with \*) or pass them as JSON. Set **Quantity** and, optionally, **Requested For**. Returns the request (REQ) and, with **Include Requested Items**, its requested items (RITMs).

### Knowledge

#### Search Knowledge

Finds published knowledge articles for a search text, for example as context for an AI agent. Optional: limit to knowledge bases, and **Include Article Text** (HTML removed). Uses the Knowledge Management REST API; when that plugin isn't active, it searches `kb_knowledge` through the Table API instead (`source: "table_api"`, no relevance score).

### Condition builder

The On Record Change trigger, Search Records, Aggregate Records, Evaluate Condition and Wait for Record share a condition builder:

- Each row has a field (including inherited fields), an operator that fits the field's type, and a value. Choice and true/false fields list their stored values; pick *Custom Value…* to type any other value.
- Rows combine with AND, OR or a new query (`^NQ`).
- Or switch to **Encoded Query** and paste a query copied from a ServiceNow list.

Fields come from ServiceNow's UI metadata API, with `sys_dictionary` as fallback. Table and field lists are cached for an hour.

## Use with AI agents

- **As a tool**: attach *ServiceNow Advanced Tool* to an AI Agent. All actions except Wait for Record are available. Request Approval and Ask Question send the request and return its `correlation_id`, because a tool call can't pause; the agent can check it later with Get Decision.
- **As a Human review gate**: attach *ServiceNow Advanced (Human review)* to the agent's tools and put other tools under it. When the agent wants to run one of those tools, an approval is requested in ServiceNow and the tool only runs once approved. A rejection comment is passed to the agent as feedback.

## Credentials

Each node has an **Authentication** option: **OAuth2** (default) or **Basic Auth**.

### OAuth2

1. In ServiceNow, create an OAuth application endpoint for external clients (**System OAuth > Application Registry**).
2. In n8n, create a **ServiceNow Advanced OAuth2 API** credential and fill in the instance URL (for example `https://dev12345.service-now.com`), client ID and client secret.
3. For the authorization code grant, copy the OAuth redirect URL from n8n into the application's **Redirect URL** in ServiceNow.

An existing OAuth application used by n8n's built-in ServiceNow node can be reused.

### Basic Auth

Create a **ServiceNow Advanced Basic Auth API** credential with the instance URL and the username and password of an integration user. n8n tests the credential against the `x_pl4_n8n` interface API, so a missing `x_pl4_n8n.api` role or a missing app shows up when you save it.

### Extra credential fields

- **n8n Base URL**: public base URL ServiceNow uses to call n8n (for example an API gateway route). Empty uses n8n's own webhook URL.
- **HITL Requester System**: code of the requester system (`x_pl4_hitl_tool` record) for this n8n environment. Required by the Human Review actions; it sets their defaults, such as the assignment group, expiry and allowed related tables.

## Compatibility

Tested against n8n 2.x.

## Development

```bash
npm install
npm run lint
npm run build
npm test
npm run dev:tunnel   # n8n with this package loaded, behind a public HTTPS tunnel
```

ServiceNow can only call n8n over a public HTTPS URL. `npm run dev:tunnel` starts a Cloudflare quick tunnel (`brew install cloudflared`); point the n8n base URL in ServiceNow at the tunnel URL it prints. The URL changes on every run. The editor stays at `http://127.0.0.1:5678`.

## License

[MIT](LICENSE). Created by Luc Raeskin for [Plat4mation](https://www.plat4mation.com).
