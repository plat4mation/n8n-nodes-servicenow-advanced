// Runs against the compiled package: `npm run build && npm test`.
// Payloads below have the shape ServiceNow actually sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildEncodedQuery, operatorsForField } = require('../dist/nodes/shared/tableMeta.js');
const { redactSignature, describeFailedRequest } = require('../dist/nodes/shared/transport.js');
const {
	ServiceNowAdvanced,
} = require('../dist/nodes/ServiceNowAdvanced/ServiceNowAdvanced.node.js');
const {
	ServiceNowAdvancedTrigger,
} = require('../dist/nodes/ServiceNowAdvancedTrigger/ServiceNowAdvancedTrigger.node.js');

const envelope = (data) => ({
	envelope_version: '1',
	message_type: 'hitl_167adf8697b373bd6ced9d95a980ba69',
	correlation_token: '33c09bf297981f10ee20b817f053afce',
	callback_url: 'https://instance.service-now.com/api/x_pl4/integration/inbound',
	data,
});

/** Minimal execute() context; `params` are the node's parameter values. */
function executeContext(params, { saved = {}, binary = {} } = {}) {
	const state = { body: undefined, waitTill: undefined, uploads: [], lookups: [] };
	const ctx = {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		isToolExecution: () => false,
		continueOnFail: () => false,
		getNode: () => ({ id: 'node-1', type: 'CUSTOM.serviceNowAdvanced', parameters: saved }),
		getExecutionId: () => '95',
		getWorkflow: () => ({ id: 'wf1', name: 'Invoice approvals' }),
		getInstanceBaseUrl: () => 'https://n8n.test/',
		evaluateExpression: (expr) =>
			expr.includes('runIndex') ? 0 : 'https://n8n.test/webhook-waiting/95?signature=resumetoken',
		getSignedResumeUrl: () => 'https://n8n.test/webhook-waiting/95/node-1?signature=hmac',
		getCredentials: async () => ({ instanceUrl: 'https://sn.test', requesterSystem: 'n8n_dev' }),
		helpers: {
			httpRequestWithAuthentication: async (_cred, options) => {
				if (options.url.includes('/attachment/file')) {
					state.uploads.push(options.url);
					return JSON.stringify({ result: { sys_id: 'a'.repeat(32) } });
				}
				if (options.method === 'GET') {
					state.lookups.push(options.url);
					return { result: [{ sys_id: 'b'.repeat(32) }] };
				}
				state.body = options.body;
				return { result: { correlation_id: 'c'.repeat(32) } };
			},
			assertBinaryData: (_i, field) => {
				if (!binary[field]) throw new Error(`no binary ${field}`);
				return binary[field];
			},
			getBinaryDataBuffer: async () => Buffer.from('%PDF'),
		},
		putExecutionToWait: async (date) => {
			state.waitTill = date;
		},
		logger: { debug() {}, warn() {} },
	};
	return { ctx, state };
}

const approval = {
	authentication: 'basicAuth',
	operation: 'sendAndWait',
	subject: 'Approve',
	contextMode: 'none',
	waitForCompletion: true,
};

test('approval uses the resume token when operation is not saved (editor default)', async () => {
	const { ctx, state } = executeContext(approval);
	await new ServiceNowAdvanced().execute.call(ctx);
	assert.equal(
		state.body.callback.endpoint.path,
		'/webhook-waiting/95/node-1?signature=resumetoken',
	);
	assert.ok(state.waitTill instanceof Date);
});

test('approval uses the signed URL only when operation sendAndWait is saved', async () => {
	const { ctx, state } = executeContext(approval, { saved: { operation: 'sendAndWait' } });
	await new ServiceNowAdvanced().execute.call(ctx);
	assert.equal(state.body.callback.endpoint.path, '/webhook-waiting/95/node-1?signature=hmac');
});

test('an invalid Expires At gives a clear error', async () => {
	const { ctx } = executeContext({ ...approval, 'options.expiresAt': 'next week' });
	await assert.rejects(new ServiceNowAdvanced().execute.call(ctx), /not a valid date/);
});

test('an empty related record value gives a clear error instead of crashing', async () => {
	const { ctx } = executeContext({
		...approval,
		'options.relatedTable': 'sc_req_item',
		'options.relatedValue': undefined,
	});
	await assert.rejects(new ServiceNowAdvanced().execute.call(ctx), /Related Record needs both/);
});

test('questions from the builder handle expression results that are numbers', async () => {
	const { ctx, state } = executeContext({
		...approval,
		operation: 'ask',
		waitForCompletion: false,
		questionsMode: 'fields',
		questions: {
			question: [
				{ id: 'monitors', label: 'Monitors', type: 'integer', min: 0, max: 3, defaultValue: 1 },
				{ id: 'laptop', label: 'Laptop', type: 'choice', choices: 'a=A\nb=B', defaultValue: 'a' },
			],
		},
	});
	await new ServiceNowAdvanced().execute.call(ctx);
	assert.deepEqual(state.body.questions[0], {
		id: 'monitors',
		label: 'Monitors',
		type: 'integer',
		min: 0,
		max: 3,
		default: 1,
	});
	assert.deepEqual(state.body.questions[1].choices, [
		{ value: 'a', label: 'A' },
		{ value: 'b', label: 'B' },
	]);
});

/** Minimal webhook() context for the HITL callback. */
function webhookContext(body, operation = 'sendAndWait') {
	const state = { status: undefined };
	return {
		state,
		ctx: {
			getNodeParameter: (name, fallback) => (name === 'operation' ? operation : fallback),
			getBodyData: () => body,
			getNode: () => ({ type: 'CUSTOM.serviceNowAdvanced' }),
			getResponseObject: () => ({ status: (code) => ({ json: () => (state.status = code) }) }),
		},
	};
}

const decision = {
	envelope_version: '1',
	message_type: 'hitl_decision',
	correlation_id: '11b0d7f297981f10ee20b817f053af7c',
	outcome: 'approved',
	data: null,
	resolved_by: 'jane.doe@example.com',
	resolved_at: '2026-11-05T23:54:43Z',
	comments: null,
	related_record: { table: 'sc_req_item', sys_id: '57ecf3ee', display_value: 'RITM0039201' },
};

test('a decision wrapped by the n8n dispatcher resumes with approved=true', async () => {
	const { ctx } = webhookContext(envelope(decision));
	const result = await new ServiceNowAdvanced().webhook.call(ctx);
	assert.equal(result.workflowData.length, 3);
	const json = result.workflowData[0][0].json;
	assert.equal(json.outcome, 'approved');
	assert.equal(json.approved, true);
	assert.equal(json.related_record.display_value, 'RITM0039201');
});

test('a rejection goes to the Rejected output, an expiry to the catch-all', async () => {
	const rejected = await new ServiceNowAdvanced().webhook.call(
		webhookContext(envelope({ ...decision, outcome: 'rejected' })).ctx,
	);
	assert.deepEqual(
		rejected.workflowData.map((output) => output.length),
		[0, 1, 0],
	);
	const expired = await new ServiceNowAdvanced().webhook.call(
		webhookContext({ ...decision, outcome: 'expired' }).ctx,
	);
	assert.deepEqual(
		expired.workflowData.map((output) => output.length),
		[0, 0, 1],
	);
});

test('the Human review variant keeps a single output for the agent', async () => {
	const { ctx } = webhookContext({ ...decision, outcome: 'rejected', comments: 'Too expensive' });
	ctx.getNode = () => ({ type: 'CUSTOM.serviceNowAdvancedHitlTool' });
	const result = await new ServiceNowAdvanced().webhook.call(ctx);
	assert.equal(result.workflowData.length, 1);
	assert.equal(result.workflowData[0][0].json.chatInput, 'Too expensive');
});

test('a timed-out wait lands on the catch-all output', async () => {
	const { ctx } = executeContext(approval);
	const outputs = await new ServiceNowAdvanced().execute.call(ctx);
	assert.deepEqual(
		outputs.map((output) => output.length),
		[0, 0, 1],
	);
	assert.equal(outputs[2][0].json.outcome, 'timed_out');
});

test('ask answers come out as answers', async () => {
	const { ctx } = webhookContext(
		{ ...decision, outcome: 'answered', data: { gl_account: '6100' } },
		'ask',
	);
	const result = await new ServiceNowAdvanced().webhook.call(ctx);
	assert.deepEqual(result.workflowData[0][0].json.answers, { gl_account: '6100' });
	assert.equal(result.workflowData.length, 3);
});

test('a callback that is not a decision is rejected and keeps the run waiting', async () => {
	const { ctx, state } = webhookContext({ hello: 'world' });
	const result = await new ServiceNowAdvanced().webhook.call(ctx);
	assert.equal(result.noWebhookResponse, true);
	assert.equal(state.status, 400);
});

test('the trigger outputs the payload of a wrapped Flow Designer call', async () => {
	const ctx = {
		getBodyData: () => envelope({ employee_name: 'Sanne de Vries', ritm_number: 'RITM0039201' }),
		helpers: { returnJsonArray: (json) => [{ json }] },
	};
	const result = await new ServiceNowAdvancedTrigger().webhook.call(ctx);
	const json = result.workflowData[0][0].json;
	assert.equal(json.ritm_number, 'RITM0039201');
	assert.equal(json._servicenow.correlation_token, '33c09bf297981f10ee20b817f053afce');
});

test('the condition builder joins AND, OR and new query and escapes ^', () => {
	assert.equal(
		buildEncodedQuery([
			{ field: 'active', operator: 'eq', value: 'true' },
			{ join: 'and', field: 'email', operator: 'changes', value: 'ignored' },
			{ join: 'or', field: 'department', operator: 'in', value: 'a1,b2' },
			{ join: 'newQuery', field: 'title', operator: 'like', value: 'CEO^CFO' },
			{ join: 'and', field: '', operator: 'eq', value: 'skipped' },
		]),
		'active=true^emailVALCHANGES^ORdepartmentINa1,b2^NQtitleLIKECEO^^CFO',
	);
});

test('resume signatures are hidden in logged request bodies', () => {
	assert.equal(
		redactSignature('{"path":"/webhook-waiting/95/node-1?signature=abc123&x=1"}'),
		'{"path":"/webhook-waiting/95/node-1?signature=***&x=1"}',
	);
});

test('requests carry a link to the n8n run unless switched off', async () => {
	const on = executeContext({ ...approval, waitForCompletion: false });
	await new ServiceNowAdvanced().execute.call(on.ctx);
	assert.equal(on.state.body.context.n8n_execution, 'https://n8n.test/workflow/wf1/executions/95');
	assert.equal(on.state.body.context.n8n_workflow, 'Invoice approvals');

	const off = executeContext({
		...approval,
		waitForCompletion: false,
		'options.includeRunLink': false,
	});
	await new ServiceNowAdvanced().execute.call(off.ctx);
	assert.equal(off.state.body.context, undefined);
});

test('related record pickers: list gives sys_id, By Number gives number, old saved strings still work', async () => {
	const sysId = '57ecf3ee83589b107b167755eeaad3d4';
	const cases = [
		[{ __rl: true, mode: 'list', value: sysId }, {}, { table: 'incident', sys_id: sysId }],
		[
			{ __rl: true, mode: 'number', value: 'INC0012345' },
			{},
			{ table: 'incident', number: 'INC0012345' },
		],
		['INC0012345', {}, { table: 'incident', number: 'INC0012345' }],
		[sysId, { options: { relatedLookup: 'sysId' } }, { table: 'incident', sys_id: sysId }],
	];
	for (const [value, saved, expected] of cases) {
		const { ctx, state } = executeContext(
			{
				...approval,
				waitForCompletion: false,
				'options.includeRunLink': false,
				'options.relatedTable': 'incident',
				'options.relatedValue': value,
			},
			{ saved },
		);
		await new ServiceNowAdvanced().execute.call(ctx);
		assert.deepEqual(state.body.related_record, expected);
	}
});

test('attachments are uploaded to the related record and named in the context', async () => {
	const { ctx, state } = executeContext(
		{
			...approval,
			waitForCompletion: false,
			'options.includeRunLink': false,
			'options.relatedTable': 'sc_req_item',
			'options.relatedValue': { __rl: true, mode: 'number', value: 'RITM0039201' },
			'options.attachments': 'invoice',
		},
		{ binary: { invoice: { fileName: 'INV-0412.pdf', mimeType: 'application/pdf' } } },
	);
	await new ServiceNowAdvanced().execute.call(ctx);
	assert.equal(state.lookups.length, 1, 'number is resolved to a sys_id once');
	assert.match(
		state.uploads[0],
		/table_name=sc_req_item&table_sys_id=b{32}&file_name=INV-0412\.pdf/,
	);
	assert.equal(state.body.context.attachments, 'INV-0412.pdf');
});

test('attachments without a related record give a clear error', async () => {
	const { ctx } = executeContext({
		...approval,
		waitForCompletion: false,
		'options.attachments': 'data',
	});
	await assert.rejects(new ServiceNowAdvanced().execute.call(ctx), /need a Related Record/);
});

test('operators follow the field type; a picked choice wins over the typed value', () => {
	assert.deepEqual(operatorsForField({ type: 'boolean' }), [
		'eq',
		'neq',
		'changes',
		'changesFrom',
		'changesTo',
	]);
	assert.ok(!operatorsForField({ type: 'string', isChoice: true }).includes('like'));
	assert.ok(operatorsForField({ type: 'integer' }).includes('between'));
	assert.ok(!operatorsForField({ type: 'string' }).includes('gt'));
	assert.equal(operatorsForField(undefined).length, 20);
	assert.equal(
		buildEncodedQuery([{ field: 'state', operator: 'changesTo', choice: '2', value: 'ignored' }]),
		'stateCHANGESTO2',
	);
});

test('a 403 names the roles the user is missing', () => {
	const ctx = { logger: { warn() {} } };
	const error = { httpCode: '403', context: { data: { error: { message: 'Operation Failed' } } } };
	assert.match(
		describeFailedRequest(ctx, 'POST', '/api/x_pl4_hitl/v1/request', {}, error),
		/x_pl4_hitl\.api and snc_internal/,
	);
	assert.match(
		describeFailedRequest(ctx, 'POST', '/api/x_pl4_n8n/v1/interface', {}, error),
		/x_pl4_n8n\.api role/,
	);
});
