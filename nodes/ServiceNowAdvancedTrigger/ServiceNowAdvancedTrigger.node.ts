import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IHookFunctions,
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
	getFieldChoices,
	getFieldOperators,
	getWatchTableFields,
	searchWatchTables,
} from '../shared/tableMeta';
import { conditionFromParameters, watchFields } from '../shared/watchFields';

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
	return conditionFromParameters((name, fallback) => ctx.getNodeParameter(name, fallback));
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
 * What to register for the webhook n8n is currently setting up. Test and
 * production use the same identifier: "Listen for test event" points the
 * interface at the test URL and deletes it when the test ends, like activation
 * and deactivation do for the live URL.
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
					'Activating the workflow registers an interface in ServiceNow that calls it; deactivating deletes it. "Listen for test event" registers the same interface for the test URL and deletes it when the test ends.',
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
			...watchFields({ event: ['watchTable'] }, 'Trigger On', 'insert_or_update'),
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
					// Log and continue so deactivation and ending a test still succeed.
					this.logger.warn(
						`ServiceNow Advanced Trigger: could not delete interface ${identifier}: ${serviceNowErrorDetail(error) ?? (error as Error).message}`,
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
