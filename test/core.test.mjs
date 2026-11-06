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

const { scopeToRecord } = require('../dist/nodes/shared/waitForRecord.js');

/** execute() context for Wait for Record; `existing` is what the Table API check returns. */
function waitContext(input, { existing = [], interfaces = [] } = {}) {
	const params = { operation: 'waitForRecord', ...input };
	const { ctx, state } = executeContext(
		{ operation: 'waitForRecord', ...params },
		{
			saved: { operation: 'waitForRecord' },
		},
	);
	state.calls = [];
	ctx.getNodeParameter = (name, _i, fallback, options) => {
		const value = name in params ? params[name] : fallback;
		return options?.extractValue && value?.__rl ? value.value : value;
	};
	ctx.helpers.httpRequestWithAuthentication = async (_cred, options) => {
		state.calls.push(`${options.method} ${options.url}`);
		if (options.method === 'POST') state.body = options.body;
		if (options.url.includes('/api/now/table/')) return { result: existing };
		if (options.method === 'GET') return { result: { records: interfaces } };
		return { result: {} };
	};
	return { ctx, state };
}

test('wait for record: one record and every OR block are scoped to its sys_id', () => {
	assert.equal(scopeToRecord('', 'abc'), 'sys_id=abc');
	assert.equal(
		scopeToRecord('state=2^NQpriority=1', 'abc'),
		'sys_id=abc^state=2^NQsys_id=abc^priority=1',
	);
	assert.equal(scopeToRecord('state=2', ''), 'state=2');
});

test('wait for record: an already matching record continues on Matched without registering', async () => {
	const { ctx, state } = waitContext(
		{
			watchTable: { __rl: true, mode: 'list', value: 'incident' },
			conditionMode: 'query',
			watchCondition: 'state=6',
		},
		{ existing: [{ sys_id: 'r1', state: '6' }] },
	);
	const outputs = await new ServiceNowAdvanced().execute.call(ctx);
	assert.equal(outputs[0][0].json.operation, 'already_matching');
	assert.equal(outputs[1].length, 0);
	assert.ok(!state.calls.some((c) => c.startsWith('POST')), 'no interface registered');
	assert.equal(state.waitTill, undefined);
});

test('wait for record: registers a temporary watch interface on the resume URL and waits', async () => {
	const { ctx, state } = waitContext(
		{
			watchTable: { __rl: true, mode: 'list', value: 'incident' },
			watchOperation: 'update',
			conditionMode: 'builder',
			conditions: { condition: [{ field: 'state', operator: 'changesTo', choice: '6' }] },
			recordSysId: 'abc',
		},
		{
			interfaces: [
				{ identifier: 'n8n_wait_1_node1_1000000000' },
				{ identifier: 'invoice_approval' },
			],
		},
	);
	const outputs = await new ServiceNowAdvanced().execute.call(ctx);
	assert.ok(
		!state.calls.some((c) => c.startsWith('GET https://sn.test/api/now/table/')),
		'no pre-check for change operators',
	);
	assert.deepEqual(
		state.calls.filter((c) => c.startsWith('DELETE')),
		['DELETE https://sn.test/api/x_pl4_n8n/v1/interface/n8n_wait_1_node1_1000000000'],
		'only expired temporary interfaces are cleaned up',
	);
	assert.equal(state.body.type, 'watch_trigger');
	assert.equal(state.body.watch_table, 'incident');
	assert.equal(state.body.watch_condition, 'sys_id=abc^stateCHANGESTO6');
	assert.equal(state.body.path, '/webhook-waiting/95/node-1?signature=resumetoken');
	assert.match(state.body.identifier, /^n8n_wait_95_node1_\d{10}$/);
	assert.ok(state.waitTill instanceof Date);
	assert.equal(outputs[1][0].json.outcome, 'timed_out');
});

test('wait for record: the callback resumes on Matched and removes the temporary interface', async () => {
	const calls = [];
	const ctx = {
		getNodeParameter: (name, fallback) => (name === 'operation' ? 'waitForRecord' : fallback),
		getBodyData: () => ({
			envelope_version: '1',
			message_type: 'n8n_wait_95_node1_1893456000',
			data: { table: 'incident', sys_id: 'abc', operation: 'update', record: { state: '6' } },
		}),
		getNode: () => ({ type: 'CUSTOM.serviceNowAdvanced', parameters: {} }),
		getCredentials: async () => ({ instanceUrl: 'https://sn.test' }),
		helpers: {
			httpRequestWithAuthentication: async (_c, o) => {
				calls.push(`${o.method} ${o.url}`);
				return {};
			},
		},
		logger: { debug() {}, warn() {} },
	};
	const result = await new ServiceNowAdvanced().webhook.call(ctx);
	assert.equal(result.workflowData[0][0].json.record.state, '6');
	assert.equal(result.workflowData[1].length, 0);
	assert.deepEqual(calls, [
		'DELETE https://sn.test/api/x_pl4_n8n/v1/interface/n8n_wait_95_node1_1893456000',
	]);
});

const { compareRecord, changesMarkdown } = require('../dist/nodes/ServiceNowAdvanced/records.js');

/**
 * execute() context for the record/catalog/knowledge actions. `routes` maps
 * "METHOD url-fragment" to a response (or a function of the request options).
 */
function actionContext(params, routes, { items = [{ json: {} }], continueOnFail = false } = {}) {
	const calls = [];
	const ctx = {
		getInputData: () => items,
		getNodeParameter: (name, i, fallback, options) => {
			const raw = name in params ? params[name] : fallback;
			const value = typeof raw === 'function' ? raw(i) : raw;
			return options?.extractValue && value?.__rl ? value.value : value;
		},
		isToolExecution: () => false,
		continueOnFail: () => continueOnFail,
		getNode: () => ({ id: 'node-1', type: 'CUSTOM.serviceNowAdvanced', parameters: {} }),
		getExecutionId: () => '95',
		getCredentials: async () => ({ instanceUrl: 'https://sn.test' }),
		helpers: {
			httpRequestWithAuthentication: async (_c, options) => {
				calls.push({ method: options.method, url: options.url, body: options.body });
				const key = Object.keys(routes).find((k) => {
					const [method, fragment] = k.split(' ');
					return options.method === method && options.url.includes(fragment);
				});
				if (!key) return { result: [] };
				const route = routes[key];
				return typeof route === 'function' ? route(options) : route;
			},
		},
		logger: { debug() {}, warn() {} },
	};
	return { ctx, calls };
}

const run = (ctx) => new ServiceNowAdvanced().execute.call(ctx);
const table = { __rl: true, mode: 'id', value: 'sys_user' };

test('compare: stored or display values count as equal; markdown shows labels and display values', () => {
	const current = {
		sys_id: { value: 'u1', display_value: 'u1' },
		department: { value: 'd1', display_value: 'Finance' },
		active: { value: 'true', display_value: 'true' },
		title: { value: 'Consultant', display_value: 'Consultant' },
	};
	const result = compareRecord(
		current,
		{ department: 'Finance', active: '1', title: 'Senior | Consultant', bogus: 'x' },
		{ title: 'Job title' },
	);
	assert.deepEqual(result.unchanged_fields, ['department', 'active']);
	assert.deepEqual(result.unknown_fields, ['bogus']);
	assert.equal(result.changes[0].current_display, 'Consultant');
	assert.equal(
		changesMarkdown(result, true).split('\n')[2],
		'| Job title | Consultant | Senior \\| Consultant |',
	);
	assert.equal(
		changesMarkdown(compareRecord(current, { title: 'Consultant' }), true),
		'_No changes._',
	);
});

test('create or update: no match creates, a match with changes updates, no changes skips', async () => {
	const params = {
		resource: 'record',
		operation: 'upsert',
		table,
		valuesMode: 'fields',
		recordFields: {
			field: [
				{ name: 'email', value: 'a@x.test' },
				{ name: 'title', value: 'Lead' },
			],
		},
		matchFields: ['email'],
	};
	const created = actionContext(params, {
		'GET /table/sys_user?': { result: [] },
		'POST /table/sys_user?': { result: { sys_id: 'new1', email: 'a@x.test', title: 'Lead' } },
	});
	const createdOut = (await run(created.ctx))[0][0].json;
	assert.equal(createdOut.action, 'created');
	assert.equal(createdOut.warnings, undefined);
	assert.match(decodeURIComponent(created.calls[0].url), /sysparm_query=email=a@x\.test/);

	const existing = {
		result: [
			{ sys_id: { value: 'u1' }, email: { value: 'a@x.test' }, title: { value: 'Consultant' } },
		],
	};
	const updated = actionContext(params, {
		'GET /table/sys_user?': existing,
		'PATCH /table/sys_user/u1': { result: { sys_id: 'u1', title: 'Lead' } },
	});
	const out = (await run(updated.ctx))[0][0].json;
	assert.equal(out.action, 'updated');
	assert.deepEqual(
		out.changes.map((c) => c.field),
		['title'],
	);

	const same = actionContext(
		{
			...params,
			recordFields: {
				field: [
					{ name: 'email', value: 'a@x.test' },
					{ name: 'title', value: 'Consultant' },
				],
			},
		},
		{ 'GET /table/sys_user?': existing },
	);
	assert.equal((await run(same.ctx))[0][0].json.action, 'unchanged');
	assert.ok(!same.calls.some((c) => c.method === 'PATCH'));
});

test('create or update: several matches fail by default', async () => {
	const two = { result: [{ sys_id: { value: 'a' } }, { sys_id: { value: 'b' } }] };
	const { ctx } = actionContext(
		{
			resource: 'record',
			operation: 'upsert',
			table,
			valuesMode: 'json',
			recordJson: '{"email":"a@x.test"}',
			matchFields: ['email'],
		},
		{ 'GET /table/sys_user?': two },
	);
	await assert.rejects(run(ctx), /Several sys_user records match/);
});

test('bulk: one Batch API call, results per item, failures reported', async () => {
	const items = [{ json: { name: 'A' } }, { json: { name: 'B' } }];
	const { ctx, calls } = actionContext(
		{
			resource: 'record',
			operation: 'bulkWrite',
			table,
			bulkAction: 'create',
			valuesMode: 'input',
		},
		{
			'POST /api/now/v1/batch': (o) => ({
				serviced_requests: [
					{
						id: '0',
						status_code: 201,
						body: Buffer.from(JSON.stringify({ result: { sys_id: 's0' } })).toString('base64'),
					},
					{
						id: '1',
						status_code: 400,
						body: Buffer.from(JSON.stringify({ error: { message: 'Invalid' } })).toString('base64'),
					},
				],
				request_count: o.body.rest_requests.length,
			}),
		},
		{ items, continueOnFail: true },
	);
	const out = (await run(ctx))[0].map((item) => item.json);
	assert.equal(calls.length, 1);
	assert.equal(JSON.parse(Buffer.from(calls[0].body.rest_requests[1].body, 'base64')).name, 'B');
	assert.deepEqual(
		out.map((r) => r.success),
		[true, false],
	);
	assert.equal(out[1].error, 'Invalid');
});

test('aggregate: grouped stats become one item per group with numbers', async () => {
	const { ctx, calls } = actionContext(
		{
			resource: 'record',
			operation: 'aggregate',
			table: { __rl: true, mode: 'id', value: 'incident' },
			conditionMode: 'query',
			watchCondition: 'active=true',
			aggregations: { aggregation: [{ function: 'avg', field: 'reassignment_count' }] },
			groupBy: ['priority'],
		},
		{
			'GET /api/now/stats/incident': {
				result: [
					{
						stats: { count: '4', avg: { reassignment_count: '1.5' } },
						groupby_fields: [{ field: 'priority', value: '1', display_value: '1 - Critical' }],
					},
				],
			},
		},
	);
	const out = (await run(ctx))[0][0].json;
	assert.deepEqual(out, {
		table: 'incident',
		count: 4,
		group: { priority: '1 - Critical' },
		avg: { reassignment_count: 1.5 },
	});
	assert.match(calls[0].url, /sysparm_avg_fields=reassignment_count/);
});

test('order catalog item: variables are sent and requested items are returned', async () => {
	const { ctx, calls } = actionContext(
		{
			resource: 'catalog',
			operation: 'orderCatalogItem',
			catalogItem: { __rl: true, mode: 'list', value: 'item1' },
			variablesMode: 'fields',
			catalogVariables: { variable: [{ name: 'laptop', value: 'mac' }] },
			quantity: 1,
		},
		{
			'POST /items/item1/order_now': {
				result: { sys_id: 'req1', number: 'REQ0010001', request_id: 'req1' },
			},
			'GET /table/sc_req_item': { result: [{ number: 'RITM0010001' }] },
		},
	);
	const out = (await run(ctx))[0][0].json;
	assert.deepEqual(calls[0].body, { sysparm_quantity: '1', variables: { laptop: 'mac' } });
	assert.equal(out.number, 'REQ0010001');
	assert.equal(out.requested_items[0].number, 'RITM0010001');
});

test('search knowledge: one item per article, HTML stripped', async () => {
	const { ctx } = actionContext(
		{
			resource: 'knowledge',
			operation: 'searchKnowledge',
			knowledgeQuery: 'vpn',
			knowledgeLimit: 5,
		},
		{
			'GET /knowledge/articles?': {
				result: {
					articles: [
						{
							id: 'k1',
							number: 'KB0001',
							title: 'Reset VPN',
							snippet: '<b>Reset</b> your&nbsp;VPN',
						},
					],
				},
			},
		},
	);
	const out = (await run(ctx))[0].map((i) => i.json);
	assert.equal(out.length, 1);
	assert.equal(out[0].snippet, 'Reset your VPN');
});

test('record with context: journal, attachments and a related list; missing access becomes a warning', async () => {
	const { ctx } = actionContext(
		{
			resource: 'record',
			operation: 'getRecordContext',
			table: { __rl: true, mode: 'id', value: 'incident' },
			contextSysId: 'i1',
			'contextOptions.relatedLists': {
				list: [{ table: 'incident_task', referenceField: 'incident' }],
			},
		},
		{
			'GET /table/incident/i1': { result: { number: 'INC0012345' } },
			'GET /table/sys_journal_field': () => {
				throw Object.assign(new Error('Forbidden'), { httpCode: '403' });
			},
			'GET /api/now/attachment': { result: [{ file_name: 'log.txt', size_bytes: '120' }] },
			'GET /table/incident_task': { result: [{ number: 'TASK001' }] },
		},
	);
	const out = (await run(ctx))[0][0].json;
	assert.equal(out.record.number, 'INC0012345');
	assert.equal(out.journal, null);
	assert.match(out.warnings[0], /journal: Forbidden/);
	assert.equal(out.attachments[0].size_bytes, 120);
	assert.equal(out.related.incident_task[0].number, 'TASK001');
});

test('record with context: journal falls back to the record fields, attachments as binary data', async () => {
	const journal =
		'06-11-2026 14:05:38 - Jane Doe (Work notes)\nChecked the contract\nwith HR\n\n' +
		'02-11-2026 09:00:00 - Jane Doe (Work notes)\nFirst note\n\n';
	const { ctx, calls } = actionContext(
		{
			resource: 'record',
			operation: 'getRecordContext',
			table: { __rl: true, mode: 'id', value: 'x_hr_task' },
			contextSysId: 't1',
			'contextOptions.downloadAttachments': true,
		},
		{
			'GET /table/sys_journal_field': { result: [] },
			'GET /table/x_hr_task/t1': (options) =>
				options.url.includes('comments')
					? {
							result: {
								comments: '05-11-2026 16:30:00 - John Roe (Additional comments)\nPlease sign\n\n',
								work_notes: journal,
							},
						}
					: { result: { number: 'HRT001' } },
			'GET /api/now/attachment': (options) =>
				options.url.includes('/file')
					? Buffer.from('%PDF')
					: { result: [{ file_name: 'contract.pdf', content_type: 'application/pdf', size_bytes: '4', sys_id: 'a1' }] },
		},
	);
	ctx.helpers.prepareBinaryData = async (data, fileName, mimeType) => ({
		data: data.toString('base64'),
		fileName,
		mimeType,
	});
	const [item] = (await run(ctx))[0];
	assert.deepEqual(
		item.json.journal.map((e) => [e.type, e.text, e.created_on]),
		[
			['work_note', 'Checked the contract\nwith HR', '06-11-2026 14:05:38'],
			['comment', 'Please sign', '05-11-2026 16:30:00'],
			['work_note', 'First note', '02-11-2026 09:00:00'],
		],
	);
	assert.equal(item.json.journal[0].created_by, 'Jane Doe');
	assert.equal(item.json.attachments[0].binary_property, 'attachment_0');
	assert.equal(item.binary.attachment_0.fileName, 'contract.pdf');
	assert.equal(item.binary.attachment_0.data, Buffer.from('%PDF').toString('base64'));
	assert.ok(calls.some((c) => c.url.endsWith('/api/now/attachment/a1/file')));
	assert.equal(item.json.warnings, undefined);
});

test('pickers never ask n8n to extract a parameter the operation does not show', async () => {
	const { getFieldChoices } = require('../dist/nodes/shared/tableMeta.js');
	const params = {
		watchTable: { __rl: true, mode: 'list', value: 'x_hr_task' },
		'conditions.condition[0].field': 'state',
	};
	const ctx = {
		getNode: () => ({}),
		getNodeParameter: (_n, d) => d,
		getCurrentNodeParameter: (name, options) => {
			// n8n throws "Could not find property" for hidden parameters when extracting.
			if (options?.extractValue) throw new Error('Could not find property');
			const path = name.startsWith('&') ? `conditions.condition[0].${name.slice(1)}` : name;
			return params[path];
		},
		getCredentials: async () => ({ instanceUrl: 'https://sn-picker.test' }),
		logger: { debug() {}, warn() {} },
		helpers: {
			httpRequestWithAuthentication: async () => ({
				result: {
					columns: {
						state: {
							label: 'State',
							internal_type: 'integer',
							choice: 1,
							choices: [{ label: 'Open', value: '1' }],
						},
					},
				},
			}),
		},
	};
	const values = (await getFieldChoices.call(ctx)).map((o) => o.value);
	assert.ok(values.includes('1'));
});

test('evaluate condition: items go to True or False unchanged; the query is scoped to the record', async () => {
	const ids = ['a'.repeat(32), 'b'.repeat(32)];
	const { ctx, calls } = actionContext(
		{
			resource: 'record',
			operation: 'evaluateCondition',
			table: { __rl: true, mode: 'id', value: 'x_hr_task' },
			evaluateSysId: (i) => ids[i],
			conditionMode: 'query',
			watchCondition: 'state=3^NQpriority=1',
		},
		{
			'GET /table/x_hr_task?': (options) =>
				options.url.includes(ids[0]) ? { result: [{ sys_id: ids[0] }] } : { result: [] },
			'GET /table/x_hr_task/': { result: { sys_id: ids[1] } },
		},
		{ items: [{ json: { n: 1 } }, { json: { n: 2 } }] },
	);
	const [matched, unmatched] = await run(ctx);
	assert.deepEqual(matched.map((i) => i.json), [{ n: 1 }]);
	assert.deepEqual(unmatched.map((i) => i.json), [{ n: 2 }]);
	const query = decodeURIComponent(calls[0].url.split('sysparm_query=')[1].split('&')[0]);
	assert.equal(query, `sys_id=${ids[0]}^state=3^NQsys_id=${ids[0]}^priority=1`);
});

test('evaluate condition: an unreadable record is an error, not False; change operators are refused', async () => {
	const params = {
		resource: 'record',
		operation: 'evaluateCondition',
		table: { __rl: true, mode: 'id', value: 'incident' },
		evaluateSysId: 'c'.repeat(32),
		conditionMode: 'query',
		watchCondition: 'active=true',
	};
	const missing = actionContext(params, {
		'GET /table/incident/': () => {
			throw Object.assign(new Error('No Record found'), { httpCode: '404' });
		},
	});
	await assert.rejects(run(missing.ctx), /incident/);
	const changes = actionContext({ ...params, watchCondition: 'stateVALCHANGES' }, {});
	await assert.rejects(run(changes.ctx), /only exist while a record is saved/);
});

test('evaluate condition as an AI tool: one output with matches', async () => {
	const { ctx } = actionContext(
		{
			resource: 'record',
			operation: 'evaluateCondition',
			table: { __rl: true, mode: 'id', value: 'incident' },
			evaluateSysId: 'd'.repeat(32),
			conditionMode: 'query',
			watchCondition: 'active=true',
		},
		{ 'GET /table/incident?': { result: [{ sys_id: 'd'.repeat(32) }] } },
	);
	ctx.isToolExecution = () => true;
	const out = await run(ctx);
	assert.equal(out.length, 1);
	assert.equal(out[0][0].json.matches, true);
});

test('create or update and bulk: fields ServiceNow silently skipped are reported', async () => {
	const fields = {
		valuesMode: 'fields',
		recordFields: { field: [{ name: 'short_description', value: 'n8n task' }, { name: 'state', value: '1' }] },
	};
	const created = actionContext(
		{ resource: 'record', operation: 'upsert', table, ...fields, matchFields: ['short_description'] },
		{
			'GET /table/sys_user?': { result: [] },
			'POST /table/sys_user?': { result: { sys_id: 'new1', short_description: '', state: '1' } },
		},
	);
	const out = (await run(created.ctx))[0][0].json;
	assert.equal(out.action, 'created');
	assert.deepEqual(out.not_saved, ['short_description']);
	assert.match(out.warnings[0], /Not saved: short_description/);

	const body = Buffer.from(JSON.stringify({ result: { sys_id: 'b1', short_description: '' } })).toString('base64');
	const bulk = actionContext(
		{ resource: 'record', operation: 'bulkWrite', table, bulkAction: 'create', ...fields },
		{ 'POST /api/now/v1/batch': { serviced_requests: [{ id: '0', status_code: 201, body }] } },
	);
	const bulkOut = (await run(bulk.ctx))[0][0].json;
	assert.equal(bulkOut.success, true);
	assert.deepEqual(bulkOut.not_saved, ['short_description', 'state']);
});

test('search knowledge falls back to the Table API when the knowledge API is missing', async () => {
	const { ctx, calls } = actionContext(
		{
			resource: 'knowledge',
			operation: 'searchKnowledge',
			knowledgeQuery: 'leave',
			knowledgeLimit: 3,
			'knowledgeOptions.includeContent': true,
		},
		{
			'GET /api/sn_km_api': () => {
				throw Object.assign(new Error('Requested URI does not represent any resource'), {
					httpCode: '400',
				});
			},
			'GET /table/kb_knowledge': {
				result: [{ sys_id: 'k1', number: 'KB0010001', short_description: 'Leave policy', text: '<p>Annual <b>leave</b></p>' }],
			},
		},
	);
	const out = (await run(ctx))[0].map((i) => i.json);
	assert.equal(out[0].title, 'Leave policy');
	assert.equal(out[0].text, 'Annual leave');
	assert.equal(out[0].link, 'https://sn.test/kb_view.do?sysparm_article=KB0010001');
	assert.match(decodeURIComponent(calls[1].url), /workflow_state=published.*123TEXTQUERY321leave/);
});

test('aggregation fields: numbers for sum, numbers and dates for max, never choice fields', async () => {
	const { getAggregateFields } = require('../dist/nodes/shared/tableMeta.js');
	const meta = {
		result: {
			columns: {
				category: { label: 'Category', internal_type: 'string', choice: 1 },
				reassignment_count: { label: 'Reassignment count', internal_type: 'integer' },
				opened_at: { label: 'Opened', internal_type: 'glide_date_time' },
				priority: { label: 'Priority', internal_type: 'integer', choice: 3 },
			},
		},
	};
	const ctx = (fn) => ({
		getNode: () => ({}),
		getNodeParameter: (_n, d) => d,
		getCurrentNodeParameter: (name) =>
			name === '&function' ? fn : name === 'table' ? 'incident_agg' : '',
		getCredentials: async () => ({ instanceUrl: `https://sn-${fn}.test` }),
		logger: { debug() {}, warn() {} },
		helpers: { httpRequestWithAuthentication: async () => meta },
	});
	const names = async (fn) => (await getAggregateFields.call(ctx(fn))).map((o) => o.value);
	assert.deepEqual(await names('sum'), ['reassignment_count']);
	assert.deepEqual(await names('max'), ['opened_at', 'reassignment_count']);
});

test('table list: one shared download for concurrent pickers, extended tables found via super_class', async () => {
	const { searchWatchTables } = require('../dist/nodes/shared/tableMeta.js');
	let requests = 0;
	const rows = [
		{ sys_id: 't1', name: 'task', label: 'Task', super_class: '' },
		{ sys_id: 't2', name: 'incident', label: 'Incident', super_class: 't1' },
		{ sys_id: 't3', name: 'u_major_incident', label: 'Major incident', super_class: 't2' },
		{ sys_id: 't4', name: 'cmdb_ci', label: 'CI', super_class: '' },
	];
	const ctx = {
		getNode: () => ({}),
		getNodeParameter: (_n, d) => d,
		getCredentials: async () => ({ instanceUrl: 'https://sn-cache.test' }),
		logger: { debug() {}, warn() {} },
		helpers: {
			httpRequestWithAuthentication: async (_c, options) => {
				if (!options.url.includes('sys_db_object')) return { result: {} };
				requests++;
				assert.match(options.url, /sysparm_no_count=true/);
				await new Promise((resolve) => setImmediate(resolve));
				return { result: rows };
			},
		},
	};
	const [a, b] = await Promise.all([
		searchWatchTables.call(ctx, 'inc'),
		searchWatchTables.call(ctx, ''),
	]);
	await searchWatchTables.call(ctx, 'major');
	assert.equal(requests, 1);
	assert.deepEqual(
		a.results.map((r) => r.value),
		['incident', 'u_major_incident'],
	);
	assert.ok(!b.results.some((r) => r.value === 'cmdb_ci'));
});

test('table list: pages through sys_db_object until a short page', async () => {
	const { searchAllTables } = require('../dist/nodes/shared/tableMeta.js');
	const offsets = [];
	const ctx = {
		getNode: () => ({}),
		getNodeParameter: (_n, d) => d,
		getCredentials: async () => ({ instanceUrl: 'https://sn-paging.test' }),
		logger: { debug() {}, warn() {} },
		helpers: {
			httpRequestWithAuthentication: async (_c, options) => {
				if (!options.url.includes('sys_db_object')) return { result: {} };
				const offset = Number(new URL(options.url).searchParams.get('sysparm_offset'));
				offsets.push(offset);
				const size = offset === 0 ? 5000 : 3;
				const result = Array.from({ length: size }, (_, i) => ({
					sys_id: `id${offset + i}`,
					name: offset === 0 ? `t_${i}` : `sn_hr_core_case_${i}`,
					label: offset === 0 ? `Table ${i}` : `HR Case ${i}`,
					super_class: '',
				}));
				return { result };
			},
		},
	};
	const found = await searchAllTables.call(ctx, 'sn_hr_core_case');
	assert.deepEqual(offsets, [0, 5000]);
	assert.equal(found.results.length, 3);
});

test('table pickers offer a table hidden from sys_db_object when its exact name is typed', async () => {
	const { searchAllTables } = require('../dist/nodes/shared/tableMeta.js');
	const ctx = {
		getNode: () => ({}),
		getNodeParameter: (_n, d) => d,
		getCredentials: async () => ({ instanceUrl: 'https://sn-hidden.test' }),
		logger: { debug() {}, warn() {} },
		helpers: {
			httpRequestWithAuthentication: async (_c, options) =>
				options.url.includes('/ui/meta/sn_hr_core_case')
					? { result: { columns: { number: { label: 'Number', internal_type: 'string' } } } }
					: { result: [{ sys_id: 't1', name: 'incident', label: 'Incident', super_class: '' }] },
		},
	};
	const found = await searchAllTables.call(ctx, 'sn_hr_core_case');
	assert.deepEqual(
		found.results.map((r) => r.value),
		['sn_hr_core_case'],
	);
	assert.match(found.results[0].name, /not in table list/);
	assert.deepEqual(
		(await searchAllTables.call(ctx, 'incident')).results.map((r) => r.value),
		['incident'],
	);
});
