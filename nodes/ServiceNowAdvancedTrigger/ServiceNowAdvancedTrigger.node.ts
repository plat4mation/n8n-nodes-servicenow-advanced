import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IHookFunctions,
	type INodeProperties,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
	type JsonObject,
} from 'n8n-workflow';
import {
	authenticationProperty,
	describeFailedRequest,
	INTERFACE_API,
	serviceNowApiRequest,
	serviceNowCredentials,
	serviceNowErrorDetail,
	statusOf,
	urlOrigin,
	urlPath,
} from '../shared/transport';
import {
	buildEncodedQuery,
	getFieldChoices,
	getFieldOperators,
	getWatchTableFields,
	OPERATORS_WITHOUT_VALUE,
	searchWatchTables,
	type ConditionRow,
} from '../shared/tableMeta';

/**
 * One row of the condition builder. Kept as a named constant: the lint autofix
 * for inline fixedCollection values re-sorts them and drops displayOptions.
 */
const conditionFields: INodeProperties[] = [
	{
		displayName: 'Combine With Previous',
		name: 'join',
		type: 'options',
		options: [
			{ name: 'AND', value: 'and' },
			{ name: 'OR', value: 'or' },
			{
				name: 'New Query (OR Block)',
				value: 'newQuery',
				description: 'Start a new group (^NQ); the record matches if any group matches',
			},
		],
		default: 'and',
		description:
			'How this condition combines with the one above it. Ignored on the first condition.',
	},
	{
		displayName: 'Field Name or ID',
		name: 'field',
		hint: 'Dot-walking (e.g. caller_id.department) works as an expression',
		type: 'options',
		typeOptions: {
			loadOptionsMethod: 'getWatchTableFields',
			loadOptionsDependsOn: ['watchTable.value'],
		},
		default: '',
		description:
			'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
	},
	{
		displayName: 'Operator Name or ID',
		name: 'operator',
		type: 'options',
		typeOptions: {
			loadOptionsMethod: 'getFieldOperators',
			loadOptionsDependsOn: ['watchTable.value', '&field'],
		},
		default: 'eq',
		description:
			'Operators that fit the field\'s type. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Choice Name or ID',
		name: 'choice',
		type: 'options',
		typeOptions: {
			loadOptionsMethod: 'getFieldChoices',
			loadOptionsDependsOn: ['watchTable.value', '&field'],
		},
		default: '',
		description:
			'For choice and true/false fields: pick the stored value. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: { hide: { operator: OPERATORS_WITHOUT_VALUE } },
	},
	{
		displayName: 'Value',
		name: 'value',
		type: 'string',
		default: '',
		placeholder: 'e.g. 2',
		description:
			'Used when no choice is picked above. Enter the stored value, e.g. a sys_id for reference fields; comma-separated for "is one of"; 10@20 for "between".',
		displayOptions: { hide: { operator: OPERATORS_WITHOUT_VALUE } },
	},
];

/** ServiceNow's identifier rule. */
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

/**
 * Body for POST /interface (InterfaceUpsertRequest). The watch_* fields are
 * always sent: null for Flow Designer interfaces, because ServiceNow requires
 * them cleared when an interface switches away from watch_trigger (and
 * expected_payload cleared when it switches to it).
 */
interface InterfaceRegistration extends IDataObject {
	identifier: string;
	name: string;
	type: 'trigger' | 'watch_trigger';
	path: string;
	base_url: string;
	expected_payload: IDataObject | null;
	watch_table: string | null;
	watch_operation: 'insert' | 'update' | 'insert_or_update' | null;
	watch_condition: string | null;
}

/** The encoded query from the condition builder or the raw query field. */
function watchConditionFor(ctx: IHookFunctions): string {
	if (ctx.getNodeParameter('conditionMode', 'builder') === 'query') {
		return hookText(ctx, 'watchCondition');
	}
	const rows =
		(ctx.getNodeParameter('conditions', {}) as { condition?: ConditionRow[] }).condition ?? [];
	return buildEncodedQuery(rows);
}

/** A text parameter in a hook context, trimmed; expressions can resolve to undefined. */
function hookText(ctx: IHookFunctions, name: string): string {
	const value = ctx.getNodeParameter(name, '') as unknown;
	return value === undefined || value === null ? '' : String(value).trim();
}

interface PayloadField {
	name?: string;
	type?: 'string' | 'number' | 'boolean' | 'json';
	example?: string;
}

/** Build the expected_payload object from the Payload Fields rows. */
function payloadFromFields(ctx: IHookFunctions): IDataObject | null {
	const rows =
		(ctx.getNodeParameter('payloadFields', {}) as { field?: PayloadField[] }).field ?? [];
	const payload: IDataObject = {};
	for (const row of rows) {
		// Expressions can resolve to numbers or undefined.
		const key = String(row.name ?? '').trim();
		const type = row.type ?? 'string';
		const example = String(row.example ?? '');
		if (!key) continue;
		if (type === 'number') {
			const num = example.trim() === '' ? 0 : Number(example);
			if (!Number.isFinite(num)) {
				throw new NodeOperationError(ctx.getNode(), `Example for "${key}" is not a number`);
			}
			payload[key] = num;
		} else if (type === 'boolean') {
			payload[key] = example.trim().toLowerCase() === 'true';
		} else if (type === 'json') {
			try {
				payload[key] = example.trim() ? JSON.parse(example) : {};
			} catch {
				throw new NodeOperationError(ctx.getNode(), `Example for "${key}" is not valid JSON`);
			}
		} else {
			payload[key] = example;
		}
	}
	return Object.keys(payload).length ? payload : null;
}

function parseExpectedPayload(ctx: IHookFunctions): IDataObject | null {
	const mode = ctx.getNodeParameter('payloadMode', 'none') as string;
	if (mode === 'none') return null;
	if (mode === 'fields') return payloadFromFields(ctx);

	const raw = ctx.getNodeParameter('expectedPayload', '') as string | IDataObject;
	let value: unknown = raw;
	if (typeof raw === 'string') {
		if (!raw.trim()) return null;
		try {
			value = JSON.parse(raw);
		} catch {
			throw new NodeOperationError(ctx.getNode(), 'Expected Payload is not valid JSON');
		}
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new NodeOperationError(ctx.getNode(), 'Expected Payload must be a JSON object');
	}
	return Object.keys(value).length ? (value as IDataObject) : null;
}

/**
 * n8n serves the same webhook under `/webhook-test/` while listening in the
 * editor and under `/webhook/` once the workflow is active.
 */
function isTestPath(path: string): boolean {
	return /\/webhook-test\//.test(path);
}

function productionPath(path: string): string {
	return path.replace(/\/webhook-test\//, '/webhook/');
}

/**
 * What to register for the webhook n8n is currently setting up. Test and
 * production use the same identifier: Flow Designer references the interface
 * record, so "Listen for test event" repoints that record to the test URL
 * instead of creating a separate one.
 */
async function registrationFor(ctx: IHookFunctions): Promise<InterfaceRegistration> {
	const webhookUrl = ctx.getNodeWebhookUrl('default') as string;

	const identifier = hookText(ctx, 'identifier');
	if (!IDENTIFIER_PATTERN.test(identifier)) {
		throw new NodeOperationError(ctx.getNode(), `Interface Identifier "${identifier}" is invalid`, {
			description:
				'Use lowercase snake_case: start with a letter, then letters, digits or underscores, at most 100 characters.',
		});
	}
	const name = (hookText(ctx, 'interfaceName') || identifier).slice(0, 100);

	const { credentials } = await serviceNowCredentials.call(ctx);
	const baseUrl =
		((credentials.n8nBaseUrl as string | undefined) ?? '').trim().replace(/\/+$/, '') ||
		urlOrigin(webhookUrl);

	const base = { identifier, name, path: urlPath(webhookUrl), base_url: baseUrl };

	if (ctx.getNodeParameter('event', 'flowDesigner') === 'watchTable') {
		const table = String(
			ctx.getNodeParameter('watchTable', '', { extractValue: true }) ?? '',
		).trim();
		if (!table) {
			throw new NodeOperationError(ctx.getNode(), 'Table is required for On Record Change');
		}
		return {
			...base,
			type: 'watch_trigger',
			expected_payload: null,
			watch_table: table,
			watch_operation: ctx.getNodeParameter(
				'watchOperation',
				'insert_or_update',
			) as InterfaceRegistration['watch_operation'],
			watch_condition: watchConditionFor(ctx) || null,
		};
	}

	return {
		...base,
		type: 'trigger',
		expected_payload: parseExpectedPayload(ctx),
		watch_table: null,
		watch_operation: null,
		watch_condition: null,
	};
}

/** POST /interface, wrapping failures with ServiceNow's own error text. */
async function upsertInterface(
	ctx: IHookFunctions,
	registration: InterfaceRegistration,
): Promise<void> {
	try {
		await serviceNowApiRequest.call(ctx, 'POST', `${INTERFACE_API}/interface`, registration);
	} catch (error) {
		const status = statusOf(error);
		throw new NodeApiError(ctx.getNode(), error as JsonObject, {
			message: `Could not register interface "${registration.identifier}" in ServiceNow${status ? ` (HTTP ${status})` : ''}`,
			description: describeFailedRequest(
				ctx,
				'POST',
				`${INTERFACE_API}/interface`,
				registration,
				error,
			),
		});
	}
}

/** GET the interface; undefined when ServiceNow answers 404. */
async function getInterface(
	ctx: IHookFunctions,
	identifier: string,
): Promise<IDataObject | undefined> {
	try {
		const response = await serviceNowApiRequest.call(
			ctx,
			'GET',
			`${INTERFACE_API}/interface/${encodeURIComponent(identifier)}`,
		);
		return ((response.result as IDataObject)?.record as IDataObject) ?? {};
	} catch (error) {
		if (statusOf(error) === 404) return undefined;
		throw new NodeApiError(ctx.getNode(), error as JsonObject);
	}
}

export class ServiceNowAdvancedTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ServiceNow Advanced Trigger',
		name: 'serviceNowAdvancedTrigger',
		icon: {
			light: 'file:../../icons/servicenow.svg',
			dark: 'file:../../icons/servicenow.dark.svg',
		},
		group: ['trigger'],
		version: 1,
		subtitle:
			'={{ $parameter["event"] === "watchTable" ? "Record change: " + ($parameter["watchTable"]?.value ?? $parameter["watchTable"]) : "Flow Designer: " + $parameter["identifier"] }}',
		description:
			'Starts the workflow when a ServiceNow Flow Designer flow calls it, or when a record in a ServiceNow table changes',
		defaults: {
			name: 'ServiceNow Advanced Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'serviceNowAdvancedOAuth2Api',
				required: true,
				displayOptions: { show: { authentication: ['oAuth2'] } },
			},
			{
				name: 'serviceNowAdvancedBasicApi',
				required: true,
				displayOptions: { show: { authentication: ['basicAuth'] } },
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'flow',
			},
		],
		properties: [
			authenticationProperty,
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'On Flow Designer Call',
						value: 'flowDesigner',
						description: 'A Flow Designer flow calls the n8n interface registered by this node',
					},
					{
						name: 'On Record Change',
						value: 'watchTable',
						description:
							'A record in a ServiceNow table is inserted or updated and matches an encoded query',
					},
				],
				default: 'flowDesigner',
			},
			{
				displayName:
					'On activation this node registers an interface in ServiceNow that calls this workflow. "Listen for test event" temporarily points the same interface at the test URL, so live calls go to the editor while you test; it is pointed back when the test ends and the workflow is active.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Interface Identifier',
				name: 'identifier',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. invoice_approval',
				description:
					'Unique identifier of the interface in ServiceNow; flows select the interface by this value. Lowercase snake_case, at most 100 characters. Registering an existing identifier repoints it to this workflow.',
			},
			{
				displayName: 'Interface Name',
				name: 'interfaceName',
				type: 'string',
				default: '',
				placeholder: 'e.g. Invoice approval',
				description: 'Display name of the interface in ServiceNow. Defaults to the identifier.',
			},
			{
				displayName: 'On Deactivation',
				name: 'onDeactivate',
				type: 'options',
				options: [
					{
						name: 'Keep Interface',
						value: 'keep',
						description: 'Leave the record in ServiceNow so flows keep referencing it',
					},
					{
						name: 'Delete Interface',
						value: 'delete',
						description: 'Remove the record from ServiceNow when the workflow is deactivated',
					},
				],
				default: 'keep',
			},
			{
				displayName: 'Table',
				name: 'watchTable',
				type: 'resourceLocator',
				required: true,
				default: { mode: 'list', value: '' },
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: { searchListMethod: 'searchWatchTables', searchable: true },
					},
					{
						displayName: 'By Name',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. incident',
					},
				],
				description:
					'Table to watch. Must be an active n8n watch table in ServiceNow (by default task, sys_user and x_pl4_hrlifecycle4_lifecycle_user) or a table that extends one, such as incident.',
				displayOptions: { show: { event: ['watchTable'] } },
			},
			{
				displayName: 'Trigger On',
				name: 'watchOperation',
				type: 'options',
				options: [
					{ name: 'Insert', value: 'insert' },
					{ name: 'Insert or Update', value: 'insert_or_update' },
					{ name: 'Update', value: 'update' },
				],
				default: 'insert_or_update',
				displayOptions: { show: { event: ['watchTable'] } },
			},
			{
				displayName: 'Condition',
				name: 'conditionMode',
				type: 'options',
				options: [
					{ name: 'Using Condition Builder', value: 'builder' },
					{ name: 'Using Encoded Query', value: 'query' },
				],
				default: 'builder',
				description:
					'Which records trigger the workflow. No conditions means every insert or update.',
				displayOptions: { show: { event: ['watchTable'] } },
			},
			{
				displayName: 'Conditions',
				name: 'conditions',
				type: 'fixedCollection',
				placeholder: 'Add Condition',
				typeOptions: { multipleValues: true, sortable: true },
				default: {},
				displayOptions: { show: { event: ['watchTable'], conditionMode: ['builder'] } },
				options: [{ displayName: 'Condition', name: 'condition', values: conditionFields }],
			},
			{
				displayName: 'Encoded Query',
				name: 'watchCondition',
				type: 'string',
				default: '',
				placeholder: 'e.g. active=true^emailVALCHANGES',
				description:
					'Encoded query the record must match when it is saved. Change operators such as VALCHANGES and CHANGESTO work. Leave empty to trigger on every insert or update.',
				hint: 'Build the filter on a list in ServiceNow and use "Copy query"',
				displayOptions: { show: { event: ['watchTable'], conditionMode: ['query'] } },
			},
			{
				displayName: 'Expected Payload',
				name: 'payloadMode',
				type: 'options',
				options: [
					{ name: 'None', value: 'none' },
					{ name: 'Using Fields Below', value: 'fields' },
					{ name: 'Using JSON', value: 'json' },
				],
				default: 'fields',
				description:
					'Example of the data the flow sends. Its top-level keys become the inputs of the Flow Designer action.',
				displayOptions: { show: { event: ['flowDesigner'] } },
			},
			{
				displayName: 'Payload Fields',
				name: 'payloadFields',
				type: 'fixedCollection',
				placeholder: 'Add Field',
				typeOptions: { multipleValues: true, sortable: true },
				default: {},
				displayOptions: { show: { event: ['flowDesigner'], payloadMode: ['fields'] } },
				options: [
					{
						displayName: 'Field',
						name: 'field',
						values: [
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
								placeholder: 'e.g. invoice_number',
								description: 'Key in the payload; becomes an input of the Flow Designer action',
							},
							{
								displayName: 'Type',
								name: 'type',
								type: 'options',
								options: [
									{ name: 'Boolean', value: 'boolean' },
									{ name: 'JSON', value: 'json' },
									{ name: 'Number', value: 'number' },
									{ name: 'String', value: 'string' },
								],
								default: 'string',
							},
							{
								displayName: 'Example Value',
								name: 'example',
								type: 'string',
								default: '',
								placeholder: 'e.g. INV0001',
								description:
									'Example value, used by ServiceNow to show what the flow should send. For JSON, enter an object or array.',
							},
						],
					},
				],
			},
			{
				displayName: 'Payload JSON',
				name: 'expectedPayload',
				type: 'json',
				required: true,
				default: '{\n  "invoice_number": "INV0001",\n  "amount": 100\n}',
				displayOptions: { show: { event: ['flowDesigner'], payloadMode: ['json'] } },
				description: 'Example payload as a JSON object',
			},
		],
	};

	methods = {
		listSearch: { searchWatchTables },
		loadOptions: { getWatchTableFields, getFieldOperators, getFieldChoices },
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				// POST /interface is an idempotent upsert (action "unchanged" when nothing
				// differs), so always let create() run: that also pushes edited names,
				// payloads and base URLs without comparing every field here.
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				await upsertInterface(this, await registrationFor(this));
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				let identifier = '';
				try {
					const registration = await registrationFor(this);
					identifier = registration.identifier;

					if (isTestPath(registration.path)) {
						// Test listening ended: point the record back at the live webhook,
						// but only if the workflow is active. Otherwise there is nothing live
						// to point at and the record stays as it is.
						if (this.getWorkflow().active) {
							await upsertInterface(this, {
								...registration,
								path: productionPath(registration.path),
							});
						}
						return true;
					}

					if (this.getNodeParameter('onDeactivate', 'keep') !== 'delete') return true;

					const record = await getInterface(this, identifier);
					// Leave it alone if it's gone or another workflow has taken it over.
					if (record && record.path === registration.path) {
						await serviceNowApiRequest.call(
							this,
							'DELETE',
							`${INTERFACE_API}/interface/${encodeURIComponent(identifier)}`,
						);
					}
				} catch (error) {
					// Log and continue so deactivation still succeeds.
					this.logger.warn(
						`ServiceNow Advanced Trigger: could not update or delete interface ${identifier}: ${serviceNowErrorDetail(error) ?? (error as Error).message}`,
					);
				}
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		// ServiceNow's integration framework wraps the payload:
		// {envelope_version, message_type, correlation_token, callback_url, data: {…payload}}.
		// For Flow Designer `data` is the flow's payload; for record changes it is
		// {table, sys_id, operation, record}. Output `data` itself and keep the
		// envelope under `_servicenow`.
		const body = this.getBodyData() as IDataObject;
		const data = body?.data;
		const isEnvelope =
			data !== null &&
			typeof data === 'object' &&
			!Array.isArray(data) &&
			'envelope_version' in body;
		const json: IDataObject = isEnvelope
			? {
					...(data as IDataObject),
					_servicenow: {
						message_type: body.message_type,
						correlation_token: body.correlation_token,
						callback_url: body.callback_url,
						envelope_version: body.envelope_version,
					},
				}
			: body;
		return {
			workflowData: [this.helpers.returnJsonArray(json)],
		};
	}
}
