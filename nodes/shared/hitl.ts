import {
	NodeApiError,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type IWebhookDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
	type JsonObject,
} from 'n8n-workflow';
import {
	describeFailedRequest,
	HITL_API,
	serviceNowApiRequest,
	serviceNowCredentials,
	serviceNowUploadAttachment,
	statusOf,
	urlOrigin,
	urlPath,
} from './transport';

/**
 * Runtime for the ServiceNow Advanced node's HITL operations (Request Approval,
 * Ask Question, Report Error). They all POST one `hitl_request` envelope to
 * `/api/x_pl4_hitl/v1/request` and differ only in `review_type` and the
 * type-specific keys (`questions` for ask, `error` + `related_record` for error).
 */

export type ReviewType = 'approval' | 'ask' | 'error';

/**
 * Operation value -> review_type. Request Approval uses n8n's `sendAndWait`
 * value on purpose: n8n then generates a "Human review" (`…HitlTool`) variant
 * of the node that gates other AI agent tools.
 */
export const REVIEW_TYPE_BY_OPERATION: Record<string, ReviewType> = {
	sendAndWait: 'approval',
	ask: 'ask',
	reportError: 'error',
};

/**
 * Outputs of a waiting Approval / Ask step: one per decision, then a catch-all
 * for expired, timed out (also how a cancelled request ends, since ServiceNow
 * never pushes it) and already-settled retries. Keep in sync with
 * `outcomeOutputsExpression` in the node description.
 */
const OUTCOME_OUTPUTS: Record<'approval' | 'ask', [string, string]> = {
	approval: ['approved', 'rejected'],
	ask: ['answered', 'declined'],
};

/** A waiting step's result, routed to its outcome output (or the only output). */
function routeDecision(
	reviewType: ReviewType,
	item: INodeExecutionData,
	byOutcome: boolean,
): INodeExecutionData[][] {
	if (!byOutcome || reviewType === 'error') return [[item]];
	const index = OUTCOME_OUTPUTS[reviewType].indexOf(String(item.json.outcome));
	const outputs: INodeExecutionData[][] = [[], [], []];
	outputs[index === -1 ? 2 : index].push(item);
	return outputs;
}

/** True for n8n's generated Human review variant (`serviceNowAdvancedHitlTool`). */
function isHumanReviewNode(ctx: IExecuteFunctions | IWebhookFunctions): boolean {
	return ctx.getNode().type.endsWith('HitlTool');
}

/** Extra time n8n keeps waiting after `expires_at`, so ServiceNow can still push the expiry. */
const EXPIRY_GRACE_MS = 15 * 60 * 1000;

/**
 * Resume webhook for "Wait for Completion". Same shape as n8n's own
 * send-and-wait nodes: one path per node under /webhook-waiting/<execution>/,
 * so two HITL nodes in one execution never share a callback endpoint.
 */
export const hitlWebhooks: IWebhookDescription[] = [
	{
		name: 'default',
		httpMethod: 'POST',
		responseMode: 'onReceived',
		responseData: '',
		path: '={{ $nodeId }}',
		restartWebhook: true,
		isFullPath: true,
	},
];

/**
 * A text parameter, trimmed. Expressions can resolve to undefined, null or a
 * number (e.g. `{{ $json.ritm_number }}` on a missing field), so never call
 * string methods on getNodeParameter's raw result.
 */
export function textParameter(ctx: IExecuteFunctions, name: string, itemIndex: number): string {
	// extractValue also reads resource locator parameters (pickers); plain values pass through.
	const value = ctx.getNodeParameter(name, itemIndex, '', { extractValue: true }) as unknown;
	return value === undefined || value === null ? '' : String(value).trim();
}

/** Read a JSON object parameter that may arrive as a string or an already-parsed object. */
export function jsonObjectParameter(
	ctx: IExecuteFunctions,
	name: string,
	itemIndex: number,
	label: string,
): IDataObject {
	const raw = ctx.getNodeParameter(name, itemIndex, {}) as string | IDataObject;
	let value: unknown = raw;
	if (typeof raw === 'string') {
		try {
			value = raw.trim() ? JSON.parse(raw) : {};
		} catch {
			throw new NodeOperationError(ctx.getNode(), `${label} is not valid JSON`, { itemIndex });
		}
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new NodeOperationError(ctx.getNode(), `${label} must be a JSON object`, { itemIndex });
	}
	return value as IDataObject;
}

/** Key/value rows from a fixedCollection with `field: [{ name, value }]`. */
export function keyValueRows(ctx: IExecuteFunctions, name: string, itemIndex: number): IDataObject {
	const rows =
		(
			ctx.getNodeParameter(name, itemIndex, {}) as {
				field?: Array<{ name?: string; value?: string }>;
			}
		).field ?? [];
	const result: IDataObject = {};
	for (const row of rows) {
		const key = String(row.name ?? '').trim();
		if (key) result[key] = row.value ?? '';
	}
	return result;
}

function contextFor(ctx: IExecuteFunctions, itemIndex: number): IDataObject | undefined {
	const mode = ctx.getNodeParameter('contextMode', itemIndex, 'none') as string;
	const context =
		mode === 'fields'
			? keyValueRows(ctx, 'contextFields', itemIndex)
			: mode === 'json'
				? jsonObjectParameter(ctx, 'contextJson', itemIndex, 'Context JSON')
				: {};
	return Object.keys(context).length ? context : undefined;
}

const SYS_ID = /^[0-9a-f]{32}$/;

/**
 * The related record as `{ table, sys_id }` or `{ table, number }`. The record
 * picker gives `{ mode, value }`: list and "By Sys ID" hold a sys_id, "By
 * Number" a number.
 */
function relatedRecordFor(
	ctx: IExecuteFunctions,
	reviewType: ReviewType,
	itemIndex: number,
): IDataObject | undefined {
	// Top-level fields for errors (required), under Options for the others.
	const prefix = reviewType === 'error' ? '' : 'options.';
	const table = textParameter(ctx, `${prefix}relatedTable`, itemIndex);
	const raw = ctx.getNodeParameter(`${prefix}relatedValue`, itemIndex, '') as
		| string
		| { mode?: string; value?: unknown };
	const isLocator = typeof raw === 'object' && raw !== null;
	const value = String((isLocator ? raw.value : raw) ?? '').trim();
	if (!table && !value) return undefined;
	if (!table || !value) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Related Record needs both a table and a record (got table "${table}", record "${value}")`,
			{ itemIndex },
		);
	}
	const bySysId = (!isLocator || raw.mode !== 'number') && SYS_ID.test(value);
	return bySysId ? { table, sys_id: value } : { table, number: value };
}

/** sys_id of the related record, looked up by number when needed. */
async function relatedSysId(ctx: IExecuteFunctions, related: IDataObject): Promise<string> {
	if (related.sys_id) return String(related.sys_id);
	const table = String(related.table);
	const query = `number=${encodeURIComponent(String(related.number))}`;
	const response = await serviceNowApiRequest.call(
		ctx,
		'GET',
		`/api/now/table/${encodeURIComponent(table)}?sysparm_query=${query}&sysparm_fields=sys_id&sysparm_limit=1`,
	);
	const sysId = ((response.result as IDataObject[]) ?? [])[0]?.sys_id;
	if (!sysId) {
		throw new NodeOperationError(
			ctx.getNode(),
			`No ${table} record with number ${String(related.number)}`,
		);
	}
	return String(sysId);
}

/**
 * Upload the item's binary fields to the related record before the request is
 * created, so the reviewer sees them. Returns the uploaded file names.
 */
async function uploadAttachments(
	ctx: IExecuteFunctions,
	itemIndex: number,
	related: IDataObject | undefined,
): Promise<string[]> {
	const fields = textParameter(ctx, 'options.attachments', itemIndex)
		.split(',')
		.map((f) => f.trim())
		.filter(Boolean);
	if (!fields.length) return [];
	if (!related) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Attachments need a Related Record to attach them to',
			{
				itemIndex,
			},
		);
	}
	const sysId = await relatedSysId(ctx, related);
	const names: string[] = [];
	for (const field of fields) {
		const binary = ctx.helpers.assertBinaryData(itemIndex, field);
		const data = await ctx.helpers.getBinaryDataBuffer(itemIndex, field);
		const fileName =
			binary.fileName ?? `${field}${binary.fileExtension ? `.${binary.fileExtension}` : ''}`;
		try {
			await serviceNowUploadAttachment.call(
				ctx,
				String(related.table),
				sysId,
				fileName,
				binary.mimeType,
				data,
			);
		} catch (error) {
			throw new NodeApiError(ctx.getNode(), error as JsonObject, {
				message: `Could not attach "${fileName}" to the related record`,
				description: describeFailedRequest(
					ctx,
					'POST',
					'/api/now/attachment/file',
					undefined,
					error,
				),
				itemIndex,
			});
		}
		names.push(fileName);
	}
	return names;
}

/** Workflow name and a link to this execution, for the reviewer. */
function runLinkContext(ctx: IExecuteFunctions): IDataObject {
	const workflow = ctx.getWorkflow();
	const base = ctx.getInstanceBaseUrl().replace(/\/+$/, '');
	return {
		n8n_workflow: workflow.name ?? workflow.id,
		n8n_execution: `${base}/workflow/${workflow.id}/executions/${ctx.getExecutionId()}`,
	};
}

/**
 * The caller's reference: unique per execution, node, run and item, and stable
 * across retries of the same item, so a retry gets the existing request back
 * (200) instead of creating a second one.
 */
function externalRefFor(ctx: IExecuteFunctions, itemIndex: number): string {
	const runIndex = ctx.evaluateExpression('{{ $runIndex }}', itemIndex) as number;
	return `${ctx.getExecutionId()}_${ctx.getNode().id}_${runIndex}_${itemIndex}`;
}

/**
 * This node's resume URL. n8n validates a waiting webhook with an HMAC-signed
 * URL (getSignedResumeUrl) only when the SAVED node parameters contain
 * `operation: "sendAndWait"`, and with the execution's resume token otherwise.
 * The editor does not save parameters left at their default, and sendAndWait
 * is our default, so check the saved value exactly like n8n does.
 */
export function resumeUrlFor(ctx: IExecuteFunctions): string {
	if (ctx.getNode().parameters.operation === 'sendAndWait') return ctx.getSignedResumeUrl();
	const resumeUrl = ctx.evaluateExpression('{{ $execution.resumeUrl }}', 0) as string;
	const [base, query] = resumeUrl.split('?');
	return `${base}/${ctx.getNode().id}${query ? `?${query}` : ''}`;
}

async function buildEnvelope(
	ctx: IExecuteFunctions,
	reviewType: ReviewType,
	itemIndex: number,
	specific: IDataObject,
	callback: IDataObject,
): Promise<IDataObject> {
	const { credentials } = await serviceNowCredentials.call(ctx);
	const requesterSystem = ((credentials.requesterSystem as string | undefined) ?? '').trim();
	if (!requesterSystem) {
		throw new NodeOperationError(ctx.getNode(), 'No HITL Requester System set', {
			itemIndex,
			description:
				'Fill in "HITL Requester System" in the ServiceNow credential (the code of the x_pl4_hitl_tool record, e.g. n8n_dev).',
		});
	}

	const body: IDataObject = {
		envelope_version: '1',
		message_type: 'hitl_request',
		requester_system: requesterSystem,
		review_type: reviewType,
		subject: ctx.getNodeParameter('subject', itemIndex) as string,
		...specific,
		callback,
	};

	const context = contextFor(ctx, itemIndex) ?? {};
	if (ctx.getNodeParameter('options.includeRunLink', itemIndex, true) as boolean) {
		Object.assign(context, runLinkContext(ctx));
	}
	// Human review variant: n8n adds a `message` parameter describing the tool
	// call the agent wants to make ({{ $tool.name }} / {{ $tool.parameters }}).
	if (isHumanReviewNode(ctx)) {
		const message = textParameter(ctx, 'message', itemIndex);
		if (message) context.agent_request = message;
	}
	if (Object.keys(context).length) body.context = context;

	const group = textParameter(ctx, 'options.assignmentGroup', itemIndex);
	if (group) body.assignment = { group };

	const expiresAt = textParameter(ctx, 'options.expiresAt', itemIndex);
	if (expiresAt) {
		const date = new Date(expiresAt);
		if (Number.isNaN(date.getTime())) {
			throw new NodeOperationError(ctx.getNode(), `Expires At "${expiresAt}" is not a valid date`, {
				itemIndex,
			});
		}
		body.expires_at = date.toISOString();
	}

	const related = relatedRecordFor(ctx, reviewType, itemIndex);
	if (related) body.related_record = related;

	const attached = await uploadAttachments(ctx, itemIndex, related);
	if (attached.length) {
		body.context = { ...((body.context as IDataObject) ?? {}), attachments: attached.join(', ') };
	}

	return body;
}

async function createRequest(
	ctx: IExecuteFunctions,
	body: IDataObject,
	itemIndex: number,
): Promise<IDataObject> {
	try {
		const response = await serviceNowApiRequest.call(ctx, 'POST', `${HITL_API}/request`, body);
		return (response.result as IDataObject) ?? {};
	} catch (error) {
		const status = statusOf(error);
		throw new NodeApiError(ctx.getNode(), error as JsonObject, {
			message: `Could not create the ServiceNow ${body.review_type as string} request${status ? ` (HTTP ${status})` : ''}`,
			description: describeFailedRequest(ctx, 'POST', `${HITL_API}/request`, body, error),
			itemIndex,
		});
	}
}

/**
 * execute() for the HITL operations. `specificFor` returns the review-type keys
 * (`questions`, or `error`) for one item.
 *
 * Waits when Wait for Completion is on in a normal workflow step, and always in
 * the Human review variant (the agent needs the decision before it may run the
 * gated tool). As a plain AI tool it only sends: a tool call can't pause.
 */
export async function executeHitl(
	ctx: IExecuteFunctions,
	reviewType: ReviewType,
	specificFor: (itemIndex: number) => IDataObject,
): Promise<INodeExecutionData[][]> {
	const items = ctx.getInputData();
	const wait =
		reviewType !== 'error' &&
		(isHumanReviewNode(ctx) ||
			(!ctx.isToolExecution() && (ctx.getNodeParameter('waitForCompletion', 0, false) as boolean)));

	if (wait) {
		const resumeUrl = resumeUrlFor(ctx);
		const { credentials } = await serviceNowCredentials.call(ctx);
		const baseUrl =
			((credentials.n8nBaseUrl as string | undefined) ?? '').trim().replace(/\/+$/, '') ||
			urlOrigin(resumeUrl);

		// The n8n dispatcher accepts only base_url and path as endpoint fields.
		const endpoint: IDataObject = { base_url: baseUrl, path: urlPath(resumeUrl) };

		const body = await buildEnvelope(ctx, reviewType, 0, specificFor(0), {
			callback_style: 'push',
			external_ref: externalRefFor(ctx, 0),
			endpoint,
		});
		const result = await createRequest(ctx, body, 0);

		// A retry of an already settled request (200 with decision_state) gets no
		// new push, so don't wait for one. The decision itself is not in that
		// response; outcome carries the state (decided, expired or cancelled).
		const state = result.decision_state as string | undefined;
		// The Human review variant has a single ai_tool output, so it never splits.
		const byOutcome = !isHumanReviewNode(ctx);
		if (state && state !== 'open') {
			const item = {
				json: decisionOutput(
					reviewType,
					{ correlation_id: result.correlation_id, outcome: state },
					isHumanReviewNode(ctx),
				),
				pairedItem: { item: 0 },
			};
			return routeDecision(reviewType, item, byOutcome);
		}

		const expiresAt = body.expires_at as string | undefined;
		// ServiceNow pushes approved/rejected/answered/declined/expired, but never
		// cancelled, so there is always a deadline: expiry + grace, or the
		// "Stop Waiting After" fallback when the tool's default expiry applies.
		const maxWaitHours = ctx.getNodeParameter('options.maxWaitHours', 0, 168) as number;
		const waitTill = expiresAt
			? new Date(new Date(expiresAt).getTime() + EXPIRY_GRACE_MS)
			: new Date(Date.now() + maxWaitHours * 60 * 60 * 1000);
		await ctx.putExecutionToWait(waitTill);

		// Becomes the output only when the wait times out; a callback replaces it.
		const item = {
			json: decisionOutput(
				reviewType,
				{ correlation_id: result.correlation_id, outcome: 'timed_out' },
				isHumanReviewNode(ctx),
			),
			pairedItem: { item: 0 },
		};
		return routeDecision(reviewType, item, byOutcome);
	}

	const sendItem = async (i: number): Promise<INodeExecutionData> => {
		const body = await buildEnvelope(ctx, reviewType, i, specificFor(i), {
			callback_style: 'none',
			external_ref: externalRefFor(ctx, i),
		});
		const result = await createRequest(ctx, body, i);
		return { json: { review_type: reviewType, ...result }, pairedItem: { item: i } };
	};

	const returnData: INodeExecutionData[] = [];
	for (let i = 0; i < items.length; i++) {
		// Only catch when the node continues on fail; otherwise the NodeApiError /
		// NodeOperationError from the helpers propagates as is.
		if (!ctx.continueOnFail()) {
			returnData.push(await sendItem(i));
			continue;
		}
		try {
			returnData.push(await sendItem(i));
		} catch (error) {
			returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
		}
	}
	return [returnData];
}

/**
 * Node output for a decision, from ServiceNow's pushed `hitl_decision`
 * (`{correlation_id, outcome, data, resolved_by, resolved_at, comments,
 * related_record}`), or a stand-in with only correlation_id + outcome for
 * timeouts and already-settled retries. Same keys in every case, so the next
 * node can rely on them: `approved` for approvals, `answers` (= `data`) for asks.
 */
function decisionOutput(
	reviewType: ReviewType,
	decision: IDataObject,
	humanReview = false,
): IDataObject {
	const output: IDataObject = {
		correlation_id: decision.correlation_id ?? null,
		outcome: decision.outcome ?? null,
	};
	if (reviewType === 'approval') output.approved = decision.outcome === 'approved';
	if (reviewType === 'ask') output.answers = (decision.data as IDataObject | null) ?? null;
	output.comments = decision.comments ?? null;
	output.resolved_by = decision.resolved_by ?? null;
	output.resolved_at = decision.resolved_at ?? null;
	output.related_record = decision.related_record ?? null;
	// The AI agent reads `approved`, and passes `chatInput` to the model as the
	// reviewer's feedback when the tool call is not approved.
	if (humanReview && !output.approved && typeof decision.comments === 'string') {
		output.chatInput = decision.comments;
	}
	return output;
}

/**
 * webhook() for waiting operations: resumes with the decision. n8n has already
 * checked the resume URL's token or signature before this runs.
 */
export async function hitlWebhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
	// The n8n dispatcher wraps the hitl_decision in its own integration envelope:
	// {envelope_version, message_type: "hitl_<id>", correlation_token, callback_url, data: {…decision}}.
	// Accept that and a bare hitl_decision.
	const raw = this.getBodyData() as IDataObject;
	const wrapped = raw?.data as IDataObject | undefined;
	const body = wrapped?.message_type === 'hitl_decision' ? wrapped : raw;
	if (body?.message_type !== 'hitl_decision' || typeof body.outcome !== 'string') {
		this.getResponseObject()
			.status(400)
			.json({ error: 'Expected a hitl_decision with an outcome' });
		return { noWebhookResponse: true };
	}

	const operation = this.getNodeParameter('operation', 'sendAndWait') as string;
	const reviewType = REVIEW_TYPE_BY_OPERATION[operation] ?? 'approval';
	const humanReview = isHumanReviewNode(this);
	return {
		workflowData: routeDecision(
			reviewType,
			{ json: decisionOutput(reviewType, body, humanReview) },
			!humanReview,
		),
	};
}

/** Operations on an existing request, addressed by its correlation_id. */
export const FOLLOW_UP_OPERATIONS = ['getDecision', 'cancelRequest', 'addWorkNote'];

const CORRELATION_ID = /^[0-9a-f]{32}$/;

/**
 * Get Decision output: the polled hitl_decision with the same keys for every
 * outcome. The decision API answers 204 without a body while the request is
 * open, so that becomes `outcome: "open"`.
 */
function polledDecision(correlationId: string, decision: IDataObject | undefined): IDataObject {
	const outcome = (decision?.outcome as string | undefined) ?? 'open';
	return {
		correlation_id: decision?.correlation_id ?? correlationId,
		outcome,
		approved: outcome === 'approved' || outcome === 'rejected' ? outcome === 'approved' : null,
		answers: outcome === 'answered' ? ((decision?.data as IDataObject | null) ?? null) : null,
		comments: decision?.comments ?? null,
		resolved_by: decision?.resolved_by ?? null,
		resolved_at: decision?.resolved_at ?? null,
		related_record: decision?.related_record ?? null,
	};
}

async function followUp(
	ctx: IExecuteFunctions,
	operation: string,
	itemIndex: number,
): Promise<IDataObject> {
	const correlationId = textParameter(ctx, 'correlationId', itemIndex).toLowerCase();
	if (!CORRELATION_ID.test(correlationId)) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Correlation ID must be the 32-character id returned when the request was created (got "${correlationId}")`,
			{ itemIndex },
		);
	}
	const request = {
		getDecision: {
			method: 'GET' as const,
			path: `${HITL_API}/decision/${correlationId}`,
			what: 'read the decision',
		},
		cancelRequest: {
			method: 'POST' as const,
			path: `${HITL_API}/request/${correlationId}/cancel`,
			what: 'cancel the request',
		},
		addWorkNote: {
			method: 'POST' as const,
			path: `${HITL_API}/review/${correlationId}/work_notes`,
			what: 'add the work note',
		},
	}[operation as 'getDecision' | 'cancelRequest' | 'addWorkNote'];

	let body: IDataObject | undefined;
	if (operation === 'cancelRequest') {
		const reason = textParameter(ctx, 'cancelReason', itemIndex);
		body = reason ? { reason: reason.slice(0, 1000) } : {};
	}
	if (operation === 'addWorkNote') {
		const note = textParameter(ctx, 'workNote', itemIndex);
		if (!note) throw new NodeOperationError(ctx.getNode(), 'Work Note is required', { itemIndex });
		if (note.length > 4000) {
			throw new NodeOperationError(ctx.getNode(), 'Work Note is longer than 4000 characters', {
				itemIndex,
			});
		}
		body = { work_notes: note };
	}

	let response: IDataObject | string | undefined;
	try {
		response = await serviceNowApiRequest.call(ctx, request.method, request.path, body);
	} catch (error) {
		const status = statusOf(error);
		throw new NodeApiError(ctx.getNode(), error as JsonObject, {
			message: `Could not ${request.what}${status ? ` (HTTP ${status})` : ''}`,
			description: describeFailedRequest(ctx, request.method, request.path, body, error),
			itemIndex,
		});
	}
	const result =
		typeof response === 'object' && response
			? (response.result as IDataObject | undefined)
			: undefined;
	if (operation === 'getDecision') return polledDecision(correlationId, result);
	return result ?? { correlation_id: correlationId };
}

/** execute() for Get Decision, Cancel Request and Add Work Note. */
export async function executeFollowUp(
	ctx: IExecuteFunctions,
	operation: string,
): Promise<INodeExecutionData[][]> {
	const out: INodeExecutionData[] = [];
	const items = ctx.getInputData();
	for (let i = 0; i < items.length; i++) {
		if (!ctx.continueOnFail()) {
			out.push({ json: await followUp(ctx, operation, i), pairedItem: { item: i } });
			continue;
		}
		try {
			out.push({ json: await followUp(ctx, operation, i), pairedItem: { item: i } });
		} catch (error) {
			out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
		}
	}
	return [out];
}
