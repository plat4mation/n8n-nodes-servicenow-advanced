import {
	NodeApiError,
	NodeOperationError,
	type IBinaryKeyData,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestMethods,
	type INodeExecutionData,
	type INodeProperties,
	type JsonObject,
} from 'n8n-workflow';
import { fieldsFor } from '../shared/tableMeta';
import {
	describeFailedRequest,
	serviceNowApiRequest,
	serviceNowDownloadAttachment,
	statusOf,
} from '../shared/transport';
import { CHANGE_OPERATORS, scopeToRecord } from '../shared/waitForRecord';
import { conditionFromParameters, conditionProperties } from '../shared/watchFields';

/**
 * Record actions on the standard Table, Batch, Aggregate and Attachment APIs:
 * Create or Update (upsert), Compare (diff), Search, Bulk Create or Update,
 * Aggregate and Get Record With Context. Fields are named so the shared
 * tableMeta pickers find the table under `table`.
 */

const TABLE_API = '/api/now/table';
const fieldNamesDescription =
	'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>';

// ---------------------------------------------------------------- properties

const show = (...operation: string[]) => ({ show: { operation } });

const tableField: INodeProperties = {
	displayName: 'Table',
	name: 'table',
	type: 'resourceLocator',
	required: true,
	default: { mode: 'list', value: '' },
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchAllTables', searchable: true },
		},
		{ displayName: 'By Name', name: 'id', type: 'string', placeholder: 'e.g. incident' },
	],
	displayOptions: show(
		'upsert',
		'diff',
		'search',
		'bulkWrite',
		'aggregate',
		'getRecordContext',
		'evaluateCondition',
	),
};

/** Field picker that reloads when the table changes. */
const fieldOptions = {
	loadOptionsMethod: 'getTableFields',
	loadOptionsDependsOn: ['table.value'],
};

/** Proposed values: a list of field/value rows or a JSON object. */
const valueFields = (operations: string[], withInput: boolean): INodeProperties[] => {
	const mode: INodeProperties = {
		displayName: 'Values',
		name: 'valuesMode',
		type: 'options',
		options: [
			...(withInput
				? [
						{
							name: 'All Input Fields',
							value: 'input',
							description: 'Every field of the input item except sys_id',
						},
					]
				: []),
			{ name: 'Using Fields Below', value: 'fields' },
			{ name: 'Using JSON', value: 'json' },
		],
		default: 'fields',
		displayOptions: show(...operations),
	};
	if (withInput) mode.default = 'input';
	return [
		mode,
		{
			displayName: 'Field Values',
			name: 'recordFields',
			type: 'fixedCollection',
			placeholder: 'Add Field',
			typeOptions: { multipleValues: true, sortable: true },
			default: {},
			displayOptions: { show: { operation: operations, valuesMode: ['fields'] } },
			options: [
				{
					displayName: 'Field',
					name: 'field',
					values: [
						{
							displayName: 'Field Name or ID',
							name: 'name',
							type: 'options',
							typeOptions: fieldOptions,
							default: '',
							description:
								'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
						},
						{ displayName: 'Value', name: 'value', type: 'string', default: '' },
					],
				},
			],
		},
		{
			displayName: 'Values JSON',
			name: 'recordJson',
			type: 'json',
			required: true,
			default: '{\n  "short_description": "Laptop broken"\n}',
			displayOptions: { show: { operation: operations, valuesMode: ['json'] } },
			description: 'Field values as a JSON object, keyed by field name',
		},
	];
};

const matchFields = (operations: string[], extraShow: IDataObject = {}): INodeProperties => ({
	displayName: 'Match On Field Names or IDs',
	name: 'matchFields',
	type: 'multiOptions',
	typeOptions: fieldOptions,
	required: true,
	default: [],
	description: `Fields that together identify the record; their values come from the values above. ${fieldNamesDescription}.`,
	displayOptions: { show: { operation: operations, ...extraShow } },
});

const displayValueOption: INodeProperties = {
	displayName: 'Values Are Display Values',
	name: 'inputDisplayValue',
	type: 'boolean',
	default: false,
	description:
		'Whether values are display values (e.g. "Finance Operations" for a group) that ServiceNow should look up, instead of stored values (sys_ids, choice values). Match fields are always compared as stored values.',
};

export const recordProperties: INodeProperties[] = [
	tableField,

	// Create or Update
	...valueFields(['upsert', 'diff'], false),
	matchFields(['upsert']),
	{
		displayName: 'Options',
		name: 'upsertOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('upsert'),
		options: [
			{
				displayName: 'If Several Records Match',
				name: 'multipleMatches',
				type: 'options',
				options: [
					{ name: 'Fail', value: 'error' },
					{ name: 'Update All', value: 'all' },
					{ name: 'Update the First', value: 'first' },
				],
				default: 'error',
			},
			{
				displayName: 'Skip Unchanged',
				name: 'skipUnchanged',
				type: 'boolean',
				default: true,
				description:
					'Whether to skip the update when nothing would change, so no business rules run and no audit entry is written',
			},
			displayValueOption,
		],
	},

	// Compare
	{
		displayName: 'Find Record By',
		name: 'findBy',
		type: 'options',
		options: [
			{ name: 'Match On Fields', value: 'fields' },
			{ name: 'Sys ID', value: 'sysId' },
		],
		default: 'sysId',
		displayOptions: show('diff'),
	},
	{
		displayName: 'Record Sys ID',
		name: 'recordSysId',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. 57ecf3ee83589b107b167755eeaad3d4',
		displayOptions: { show: { operation: ['diff'], findBy: ['sysId'] } },
	},
	matchFields(['diff'], { findBy: ['fields'] }),

	// Search and Aggregate share the condition builder
	...conditionProperties(
		{ operation: ['search', 'aggregate'] },
		'Which records to include. No conditions means all records.',
	),

	// Evaluate Condition
	{
		displayName: 'Record Sys ID',
		name: 'evaluateSysId',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. 57ecf3ee83589b107b167755eeaad3d4',
		description: 'The record to check, usually an expression with the sys_id from the previous node',
		displayOptions: show('evaluateCondition'),
	},
	...conditionProperties(
		{ operation: ['evaluateCondition'] },
		'The condition the record must match. No conditions means every record matches.',
	),
	{
		displayName: 'Field Names or IDs',
		name: 'fields',
		type: 'multiOptions',
		typeOptions: fieldOptions,
		default: [],
		description: `Fields to return; empty returns all fields. ${fieldNamesDescription}.`,
		displayOptions: show('search', 'getRecordContext'),
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: show('search'),
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		description: 'Max number of results to return',
		displayOptions: { show: { operation: ['search'], returnAll: [false] } },
	},
	{
		displayName: 'Options',
		name: 'searchOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('search'),
		options: [
			{
				displayName: 'Display Values',
				name: 'displayValue',
				type: 'options',
				options: [
					{ name: 'Both', value: 'all', description: 'Each field as { value, display_value }' },
					{ name: 'Display Values', value: 'true' },
					{ name: 'Stored Values', value: 'false' },
				],
				default: 'false',
			},
			{
				displayName: 'Order By Field Name or ID',
				name: 'orderBy',
				type: 'options',
				typeOptions: fieldOptions,
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Descending',
				name: 'descending',
				type: 'boolean',
				default: false,
				description: 'Whether to sort from high to low',
			},
		],
	},

	// Bulk
	{
		displayName: 'Action',
		name: 'bulkAction',
		type: 'options',
		options: [
			{ name: 'Create', value: 'create' },
			{ name: 'Update', value: 'update' },
		],
		default: 'create',
		description: 'All input items are sent together through the Batch API',
		displayOptions: show('bulkWrite'),
	},
	{
		displayName: 'Record Sys ID',
		name: 'bulkSysId',
		type: 'string',
		required: true,
		default: '={{ $json.sys_id }}',
		displayOptions: { show: { operation: ['bulkWrite'], bulkAction: ['update'] } },
	},
	...valueFields(['bulkWrite'], true),
	{
		displayName: 'Options',
		name: 'bulkOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('bulkWrite'),
		options: [
			{
				displayName: 'Batch Size',
				name: 'batchSize',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 200 },
				default: 50,
				description: 'Records per Batch API call',
			},
			displayValueOption,
		],
	},

	// Aggregate
	{
		displayName: 'Aggregations',
		name: 'aggregations',
		type: 'fixedCollection',
		placeholder: 'Add Aggregation',
		typeOptions: { multipleValues: true },
		default: {},
		description: 'Besides the count, which is always returned',
		displayOptions: show('aggregate'),
		options: [
			{
				displayName: 'Aggregation',
				name: 'aggregation',
				values: [
					{
						displayName: 'Function',
						name: 'function',
						type: 'options',
						options: [
							{ name: 'Average', value: 'avg' },
							{ name: 'Maximum', value: 'max' },
							{ name: 'Minimum', value: 'min' },
							{ name: 'Sum', value: 'sum' },
						],
						default: 'sum',
					},
					{
						displayName: 'Field Name or ID',
						name: 'field',
						type: 'options',
						typeOptions: {
							loadOptionsMethod: 'getAggregateFields',
							loadOptionsDependsOn: ['table.value', '&function'],
						},
						default: '',
						description:
							'Number fields; minimum and maximum also take date fields. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
				],
			},
		],
	},
	{
		displayName: 'Group By Field Names or IDs',
		name: 'groupBy',
		type: 'multiOptions',
		typeOptions: fieldOptions,
		default: [],
		description: `One output item per group. ${fieldNamesDescription}.`,
		displayOptions: show('aggregate'),
	},

	// Get Record With Context
	{
		displayName: 'Record Sys ID',
		name: 'contextSysId',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. 57ecf3ee83589b107b167755eeaad3d4',
		displayOptions: show('getRecordContext'),
	},
	{
		displayName: 'Options',
		name: 'contextOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('getRecordContext'),
		options: [
			{
				displayName: 'Include Attachments List',
				name: 'includeAttachments',
				type: 'boolean',
				default: true,
				description: 'Whether to list the attached files (names, sizes, download links)',
			},
			{
				displayName: 'Download Attachments',
				name: 'downloadAttachments',
				type: 'boolean',
				default: false,
				description:
					'Whether to add the attached files as binary data (attachment_0, attachment_1, …) for other nodes',
			},
			{
				displayName: 'Journal Entries',
				name: 'journalEntries',
				type: 'number',
				typeOptions: { minValue: 0 },
				default: 20,
				description: 'How many of the latest comments and work notes to include; 0 for none',
			},
			{
				displayName: 'Related Lists',
				name: 'relatedLists',
				type: 'fixedCollection',
				placeholder: 'Add Related List',
				typeOptions: { multipleValues: true },
				default: {},
				options: [
					{
						displayName: 'Related List',
						name: 'list',
						values: [
							{
								displayName: 'Table',
								name: 'table',
								type: 'string',
								default: '',
								placeholder: 'e.g. incident_task',
							},
							{
								displayName: 'Reference Field',
								name: 'referenceField',
								type: 'string',
								default: '',
								placeholder: 'e.g. incident',
								description: 'Field on the related table that points to this record',
							},
							{
								displayName: 'Fields',
								name: 'fields',
								type: 'string',
								default: '',
								placeholder: 'e.g. number,short_description,state',
								description: 'Comma-separated; empty returns all fields',
							},
							{
								displayName: 'Max Records',
								name: 'maxRecords',
								type: 'number',
								typeOptions: { minValue: 1 },
								default: 20,
							},
						],
					},
				],
			},
		],
	},
];

// ------------------------------------------------------------------- helpers

/** One ServiceNow call; failures carry ServiceNow's message and the request. */
async function call(
	ctx: IExecuteFunctions,
	method: IHttpRequestMethods,
	path: string,
	body: IDataObject | undefined,
	what: string,
	itemIndex?: number,
): Promise<IDataObject> {
	try {
		return await serviceNowApiRequest.call(ctx, method, path, body);
	} catch (error) {
		const status = statusOf(error);
		throw new NodeApiError(ctx.getNode(), error as JsonObject, {
			message: `Could not ${what}${status ? ` (HTTP ${status})` : ''}`,
			description: describeFailedRequest(ctx, method, path.split('?')[0], body, error),
			itemIndex,
		});
	}
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
	return Object.entries(params)
		.filter(([, v]) => v !== undefined && v !== '')
		.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
		.join('&');
}

function tableName(ctx: IExecuteFunctions, itemIndex: number): string {
	const table = String(
		ctx.getNodeParameter('table', itemIndex, '', { extractValue: true }) ?? '',
	).trim();
	if (!table) throw new NodeOperationError(ctx.getNode(), 'Table is required', { itemIndex });
	return table;
}

/** An encoded-query value: `^` must be doubled. */
function queryValue(value: unknown): string {
	return String(value ?? '').replace(/\^/g, '^^');
}

function asText(value: unknown): string {
	if (value === undefined || value === null) return '';
	return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** The proposed values of one item, as strings keyed by field name. */
function recordValues(ctx: IExecuteFunctions, itemIndex: number): IDataObject {
	const mode = ctx.getNodeParameter('valuesMode', itemIndex, 'fields') as string;
	let values: IDataObject;
	if (mode === 'input') {
		values = { ...ctx.getInputData()[itemIndex].json };
		delete values.sys_id;
	} else if (mode === 'json') {
		const raw = ctx.getNodeParameter('recordJson', itemIndex, {}) as string | IDataObject;
		try {
			values = typeof raw === 'string' ? (JSON.parse(raw || '{}') as IDataObject) : raw;
		} catch {
			throw new NodeOperationError(ctx.getNode(), 'Values JSON is not valid JSON', { itemIndex });
		}
		if (!values || typeof values !== 'object' || Array.isArray(values)) {
			throw new NodeOperationError(ctx.getNode(), 'Values JSON must be a JSON object', {
				itemIndex,
			});
		}
	} else {
		const rows =
			(
				ctx.getNodeParameter('recordFields', itemIndex, {}) as {
					field?: Array<{ name?: string; value?: unknown }>;
				}
			).field ?? [];
		values = {};
		for (const row of rows) {
			const name = String(row.name ?? '').trim();
			if (name) values[name] = row.value ?? '';
		}
	}
	const result: IDataObject = {};
	for (const [key, value] of Object.entries(values)) result[key] = asText(value);
	return result;
}

/** Encoded query that finds the record by the match fields' values. */
function matchQuery(ctx: IExecuteFunctions, values: IDataObject, itemIndex: number): string {
	const fields = (ctx.getNodeParameter('matchFields', itemIndex, []) as string[]).filter(Boolean);
	if (!fields.length) {
		throw new NodeOperationError(ctx.getNode(), 'Choose at least one field to match on', {
			itemIndex,
		});
	}
	return fields
		.map((field) => {
			if (values[field] === undefined || values[field] === '') {
				throw new NodeOperationError(
					ctx.getNode(),
					`Match field "${field}" has no value in the values`,
					{ itemIndex },
				);
			}
			return `${field}=${queryValue(values[field])}`;
		})
		.join('^');
}

type FieldValue = { value?: unknown; display_value?: unknown };

export interface FieldChange {
	field: string;
	label: string;
	current: string;
	current_display: string;
	proposed: string;
}

export interface Comparison {
	changed: boolean;
	changes: FieldChange[];
	unchanged_fields: string[];
	unknown_fields: string[];
}

function same(current: FieldValue, proposed: string): boolean {
	const p = proposed.trim();
	const value = asText(current.value).trim();
	const display = asText(current.display_value).trim();
	if (p === value || p === display) return true;
	if (p !== '' && value !== '' && Number.isFinite(Number(p)) && Number(p) === Number(value)) {
		return true;
	}
	const bool = (v: string) => (v === '1' ? 'true' : v === '0' ? 'false' : v.toLowerCase());
	return ['true', 'false'].includes(bool(p)) && bool(p) === bool(value);
}

/**
 * Compare proposed values with a record read with sysparm_display_value=all
 * (each field `{ value, display_value }`). A missing record means every field
 * is new. Proposed values may be stored or display values.
 */
export function compareRecord(
	current: IDataObject | undefined,
	proposed: IDataObject,
	labels: Record<string, string> = {},
): Comparison {
	const result: Comparison = {
		changed: false,
		changes: [],
		unchanged_fields: [],
		unknown_fields: [],
	};
	for (const [field, raw] of Object.entries(proposed)) {
		const value = asText(raw);
		const label = labels[field] ?? field;
		if (current && !(field in current)) {
			result.unknown_fields.push(field);
			continue;
		}
		const cur = (current?.[field] ?? {}) as FieldValue;
		const normalized: FieldValue = typeof cur === 'object' && cur !== null ? cur : { value: cur };
		if (current && same(normalized, value)) {
			result.unchanged_fields.push(field);
			continue;
		}
		result.changes.push({
			field,
			label,
			current: asText(normalized.value),
			current_display: asText(normalized.display_value ?? normalized.value),
			proposed: value,
		});
	}
	result.changed = result.changes.length > 0;
	return result;
}

/** Markdown table of the changes, readable for reviewers and AI agents. */
export function changesMarkdown(comparison: Comparison, exists: boolean): string {
	const cell = (v: string) =>
		v === '' ? '_empty_' : v.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
	if (!comparison.changed) return '_No changes._';
	const lines = [
		exists ? '| Field | Current | Proposed |' : '| Field | Current (new record) | Proposed |',
		'|---|---|---|',
		...comparison.changes.map(
			(c) => `| ${cell(c.label)} | ${cell(c.current_display)} | ${cell(c.proposed)} |`,
		),
	];
	if (comparison.unknown_fields.length) {
		lines.push('', `Unknown fields (not on the table): ${comparison.unknown_fields.join(', ')}`);
	}
	return lines.join('\n');
}

/** Field labels from the metadata API; plain field names if that's not readable. */
async function fieldLabels(ctx: IExecuteFunctions, table: string): Promise<Record<string, string>> {
	try {
		const fields = await fieldsFor(ctx, table);
		return Object.fromEntries(fields.map((f) => [f.element, f.label]));
	} catch {
		return {};
	}
}

/** Run `fn` per item, honouring Continue On Fail. `fn` may return several results. */
/** Binary data for an output item, keyed by its json (see perItem). */
const binaryOf = new WeakMap<IDataObject, IBinaryKeyData>();

async function perItem(
	ctx: IExecuteFunctions,
	fn: (itemIndex: number) => Promise<IDataObject | IDataObject[]>,
): Promise<INodeExecutionData[][]> {
	const out: INodeExecutionData[] = [];
	const items = ctx.getInputData();
	for (let i = 0; i < items.length; i++) {
		const push = (result: IDataObject | IDataObject[]) => {
			for (const json of Array.isArray(result) ? result : [result]) {
				const binary = binaryOf.get(json);
				out.push(binary ? { json, binary, pairedItem: { item: i } } : { json, pairedItem: { item: i } });
			}
		};
		if (!ctx.continueOnFail()) {
			push(await fn(i));
			continue;
		}
		try {
			push(await fn(i));
		} catch (error) {
			out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
		}
	}
	return [out];
}

// ------------------------------------------------------------------- actions

/**
 * Adds `not_saved` and a warning for fields sent with a value that came back
 * empty: the Table API silently skips fields the user may not write (field
 * ACLs, read-only fields) and still answers 200/201.
 */
function withNotSaved(result: IDataObject, values: IDataObject, record: IDataObject): IDataObject {
	const empty = (v: unknown) => v === undefined || v === null || v === '';
	const fields = Object.keys(values).filter((f) => !empty(values[f]) && empty(record[f]));
	if (!fields.length) return result;
	return {
		...result,
		not_saved: fields,
		warnings: [
			`Not saved: ${fields.join(', ')}. ServiceNow skips fields the user may not write (field ACLs or read-only fields) without an error.`,
		],
	};
}

async function upsert(ctx: IExecuteFunctions, i: number): Promise<IDataObject[]> {
	const table = tableName(ctx, i);
	const values = recordValues(ctx, i);
	const query = matchQuery(ctx, values, i);
	const multiple = ctx.getNodeParameter('upsertOptions.multipleMatches', i, 'error') as string;
	const skipUnchanged = ctx.getNodeParameter('upsertOptions.skipUnchanged', i, true) as boolean;
	const inputDisplay = ctx.getNodeParameter('upsertOptions.inputDisplayValue', i, false) as boolean;
	const write = qs({
		sysparm_input_display_value: inputDisplay,
		sysparm_exclude_reference_link: true,
	});

	const found = await call(
		ctx,
		'GET',
		`${TABLE_API}/${table}?${qs({
			sysparm_query: query,
			sysparm_fields: ['sys_id', ...Object.keys(values)].join(','),
			sysparm_display_value: 'all',
			sysparm_exclude_reference_link: true,
			sysparm_limit: multiple === 'all' ? 1000 : 2,
		})}`,
		undefined,
		`look up ${table} records`,
		i,
	);
	const matches = (found.result as IDataObject[]) ?? [];

	if (!matches.length) {
		const created = await call(
			ctx,
			'POST',
			`${TABLE_API}/${table}?${write}`,
			values,
			`create a ${table} record`,
			i,
		);
		const record = (created.result as IDataObject) ?? {};
		return [
			withNotSaved({ action: 'created', table, sys_id: record.sys_id ?? null, record }, values, record),
		];
	}
	if (matches.length > 1 && multiple === 'error') {
		throw new NodeOperationError(ctx.getNode(), `Several ${table} records match ${query}`, {
			itemIndex: i,
			description: 'Make the match fields more specific, or set "If Several Records Match".',
		});
	}

	const labels = await fieldLabels(ctx, table);
	const targets = multiple === 'all' ? matches : [matches[0]];
	const results: IDataObject[] = [];
	for (const target of targets) {
		const sysId = asText((target.sys_id as FieldValue)?.value ?? target.sys_id);
		const comparison = compareRecord(target, values, labels);
		if (!comparison.changed && skipUnchanged) {
			results.push({ action: 'unchanged', table, sys_id: sysId, changes: [] });
			continue;
		}
		const updated = await call(
			ctx,
			'PATCH',
			`${TABLE_API}/${table}/${sysId}?${write}`,
			values,
			`update ${table} record ${sysId}`,
			i,
		);
		const record = (updated.result as IDataObject) ?? {};
		results.push(
			withNotSaved(
				{ action: 'updated', table, sys_id: sysId, changes: comparison.changes, record },
				values,
				record,
			),
		);
	}
	return results;
}

async function diff(ctx: IExecuteFunctions, i: number): Promise<IDataObject> {
	const table = tableName(ctx, i);
	const values = recordValues(ctx, i);
	const fields = ['sys_id', ...Object.keys(values)].join(',');
	let current: IDataObject | undefined;

	if (ctx.getNodeParameter('findBy', i, 'sysId') === 'sysId') {
		const sysId = String(ctx.getNodeParameter('recordSysId', i, '') ?? '').trim();
		if (!sysId)
			throw new NodeOperationError(ctx.getNode(), 'Record Sys ID is required', { itemIndex: i });
		const response = await call(
			ctx,
			'GET',
			`${TABLE_API}/${table}/${sysId}?${qs({ sysparm_fields: fields, sysparm_display_value: 'all', sysparm_exclude_reference_link: true })}`,
			undefined,
			`read ${table} record ${sysId}`,
			i,
		);
		current = response.result as IDataObject;
	} else {
		const query = matchQuery(ctx, values, i);
		const response = await call(
			ctx,
			'GET',
			`${TABLE_API}/${table}?${qs({ sysparm_query: query, sysparm_fields: fields, sysparm_display_value: 'all', sysparm_exclude_reference_link: true, sysparm_limit: 2 })}`,
			undefined,
			`look up ${table} records`,
			i,
		);
		const matches = (response.result as IDataObject[]) ?? [];
		if (matches.length > 1) {
			throw new NodeOperationError(ctx.getNode(), `Several ${table} records match ${query}`, {
				itemIndex: i,
			});
		}
		current = matches[0];
	}

	const comparison = compareRecord(current, values, await fieldLabels(ctx, table));
	const sysId = current ? asText((current.sys_id as FieldValue)?.value ?? current.sys_id) : null;
	return {
		table,
		sys_id: sysId,
		exists: !!current,
		...comparison,
		markdown: changesMarkdown(comparison, !!current),
	};
}

async function search(ctx: IExecuteFunctions, i: number): Promise<IDataObject[]> {
	const table = tableName(ctx, i);
	const get = (name: string, fallback: unknown) => ctx.getNodeParameter(name, i, fallback);
	let query = conditionFromParameters(get);
	const orderBy = String(get('searchOptions.orderBy', '') ?? '').trim();
	if (orderBy)
		query += `${query ? '^' : ''}${get('searchOptions.descending', false) ? 'ORDERBYDESC' : 'ORDERBY'}${orderBy}`;
	const fields = (get('fields', []) as string[]).filter(Boolean);
	const returnAll = get('returnAll', false) as boolean;
	const limit = returnAll ? Infinity : Number(get('limit', 50)) || 50;
	const pageSize = Math.min(1000, limit);

	const records: IDataObject[] = [];
	for (let offset = 0; records.length < limit; offset += pageSize) {
		const response = await call(
			ctx,
			'GET',
			`${TABLE_API}/${table}?${qs({
				sysparm_query: query,
				sysparm_fields: fields.join(','),
				sysparm_display_value: String(get('searchOptions.displayValue', 'false')),
				sysparm_exclude_reference_link: true,
				sysparm_limit: Math.min(pageSize, limit - records.length),
				sysparm_offset: offset,
			})}`,
			undefined,
			`search ${table}`,
			i,
		);
		const page = (response.result as IDataObject[]) ?? [];
		records.push(...page);
		if (page.length < pageSize) break;
	}
	return records;
}

/** Bulk create/update through the Batch API: one call per batch of items. */
async function bulkWrite(ctx: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const items = ctx.getInputData();
	const action = ctx.getNodeParameter('bulkAction', 0, 'create') as string;
	const batchSize = Number(ctx.getNodeParameter('bulkOptions.batchSize', 0, 50)) || 50;
	const inputDisplay = ctx.getNodeParameter('bulkOptions.inputDisplayValue', 0, false) as boolean;
	const query = qs({
		sysparm_input_display_value: inputDisplay,
		sysparm_exclude_reference_link: true,
	});

	const sent: IDataObject[] = [];
	const requests = items.map((_item, i) => {
		const table = tableName(ctx, i);
		const values = recordValues(ctx, i);
		sent[i] = values;
		const sysId =
			action === 'update' ? String(ctx.getNodeParameter('bulkSysId', i, '') ?? '').trim() : '';
		if (action === 'update' && !sysId) {
			throw new NodeOperationError(ctx.getNode(), 'Record Sys ID is required for updates', {
				itemIndex: i,
			});
		}
		return {
			id: String(i),
			method: action === 'update' ? 'PATCH' : 'POST',
			url: `${TABLE_API}/${table}${sysId ? `/${sysId}` : ''}?${query}`,
			headers: [
				{ name: 'Content-Type', value: 'application/json' },
				{ name: 'Accept', value: 'application/json' },
			],
			body: Buffer.from(JSON.stringify(values)).toString('base64'),
		};
	});

	const results: IDataObject[] = items.map(() => ({
		success: false,
		error: 'Not processed by the Batch API',
	}));
	for (let start = 0; start < requests.length; start += batchSize) {
		const chunk = requests.slice(start, start + batchSize);
		const response = await call(
			ctx,
			'POST',
			'/api/now/v1/batch',
			{ batch_request_id: `${ctx.getExecutionId()}_${start}`, rest_requests: chunk },
			'send the batch request',
		);
		for (const served of (response.serviced_requests as IDataObject[]) ?? []) {
			const index = Number(served.id);
			let body: IDataObject = {};
			try {
				body = JSON.parse(
					Buffer.from(String(served.body ?? ''), 'base64').toString('utf8'),
				) as IDataObject;
			} catch {
				// Empty or non-JSON body: keep the status only.
			}
			const status = Number(served.status_code);
			const ok = status >= 200 && status < 300;
			const error =
				(body.error as IDataObject)?.message ?? served.error_message ?? served.status_text;
			const record = (body.result as IDataObject) ?? {};
			results[index] = ok
				? withNotSaved({ success: true, status_code: status, record }, sent[index] ?? {}, record)
				: { success: false, status_code: status, error: asText(error) };
		}
	}

	const failed = results.filter((r) => !r.success).length;
	if (failed && !ctx.continueOnFail()) {
		const first = results.findIndex((r) => !r.success);
		throw new NodeOperationError(ctx.getNode(), `${failed} of ${results.length} records failed`, {
			description: `First failure (item ${first}): ${asText(results[first].error)}. Turn on "Continue On Fail" to get the result per record instead.`,
		});
	}
	return [results.map((json, i) => ({ json, pairedItem: { item: i } }))];
}

function numberOrText(value: unknown): IDataObject[string] {
	const text = asText(value);
	return text !== '' && Number.isFinite(Number(text))
		? Number(text)
		: (value as IDataObject[string]);
}

function numbers(stats: IDataObject | undefined): IDataObject {
	const out: IDataObject = {};
	for (const [field, value] of Object.entries(stats ?? {})) out[field] = numberOrText(value);
	return out;
}

async function aggregate(ctx: IExecuteFunctions, i: number): Promise<IDataObject[]> {
	const table = tableName(ctx, i);
	const get = (name: string, fallback: unknown) => ctx.getNodeParameter(name, i, fallback);
	const rows =
		(get('aggregations', {}) as { aggregation?: Array<{ function?: string; field?: string }> })
			.aggregation ?? [];
	const byFunction: Record<string, string[]> = { avg: [], min: [], max: [], sum: [] };
	for (const row of rows) {
		if (row.field && row.function && byFunction[row.function])
			byFunction[row.function].push(row.field);
	}
	const groupBy = (get('groupBy', []) as string[]).filter(Boolean);

	const response = await call(
		ctx,
		'GET',
		`/api/now/stats/${table}?${qs({
			sysparm_query: conditionFromParameters(get),
			sysparm_count: true,
			sysparm_avg_fields: byFunction.avg.join(','),
			sysparm_min_fields: byFunction.min.join(','),
			sysparm_max_fields: byFunction.max.join(','),
			sysparm_sum_fields: byFunction.sum.join(','),
			sysparm_group_by: groupBy.join(','),
			sysparm_display_value: true,
		})}`,
		undefined,
		`aggregate ${table}`,
		i,
	);
	const result = response.result as IDataObject | IDataObject[];
	return (Array.isArray(result) ? result : [result]).map((entry) => {
		const stats = (entry?.stats as IDataObject) ?? {};
		const group: IDataObject = {};
		for (const g of (entry?.groupby_fields as IDataObject[]) ?? []) {
			group[String(g.field)] = g.display_value ?? g.value;
		}
		const out: IDataObject = { table, count: numberOrText(stats.count ?? 0) };
		if (groupBy.length) out.group = group;
		for (const fn of ['sum', 'avg', 'min', 'max']) {
			if (stats[fn]) out[fn] = numbers(stats[fn] as IDataObject);
		}
		return out;
	});
}

async function recordContext(ctx: IExecuteFunctions, i: number): Promise<IDataObject> {
	const table = tableName(ctx, i);
	const sysId = String(ctx.getNodeParameter('contextSysId', i, '') ?? '').trim();
	if (!sysId)
		throw new NodeOperationError(ctx.getNode(), 'Record Sys ID is required', { itemIndex: i });
	const fields = (ctx.getNodeParameter('fields', i, []) as string[]).filter(Boolean);
	const journalEntries = Number(ctx.getNodeParameter('contextOptions.journalEntries', i, 20));
	const downloadAttachments = ctx.getNodeParameter(
		'contextOptions.downloadAttachments',
		i,
		false,
	) as boolean;
	const includeAttachments =
		downloadAttachments ||
		(ctx.getNodeParameter('contextOptions.includeAttachments', i, true) as boolean);
	const relatedLists =
		(
			ctx.getNodeParameter('contextOptions.relatedLists', i, {}) as {
				list?: Array<{
					table?: string;
					referenceField?: string;
					fields?: string;
					maxRecords?: number;
				}>;
			}
		).list ?? [];

	const record = await call(
		ctx,
		'GET',
		`${TABLE_API}/${table}/${sysId}?${qs({ sysparm_fields: fields.join(','), sysparm_display_value: true, sysparm_exclude_reference_link: true })}`,
		undefined,
		`read ${table} record ${sysId}`,
		i,
	);
	const out: IDataObject = { table, sys_id: sysId, record: (record.result as IDataObject) ?? {} };
	const warnings: string[] = [];

	// Extra context is best effort: a missing read role must not lose the record.
	const optional = async (
		label: string,
		run: () => Promise<IDataObject[]>,
	): Promise<IDataObject[] | null> => {
		try {
			return await run();
		} catch (error) {
			warnings.push(`${label}: ${(error as Error).message}`);
			return null;
		}
	};

	if (journalEntries > 0) {
		out.journal = await optional('journal', async () => {
			let journalError: unknown;
			try {
				const response = await serviceNowApiRequest.call(
					ctx,
					'GET',
					`${TABLE_API}/sys_journal_field?${qs({
						sysparm_query: `element_id=${sysId}^elementINcomments,work_notes^ORDERBYDESCsys_created_on`,
						sysparm_fields: 'element,value,sys_created_by,sys_created_on',
						sysparm_limit: journalEntries,
					})}`,
				);
				const entries = (response.result as IDataObject[]) ?? [];
				if (entries.length) {
					return entries.map((entry) => ({
						type: entry.element === 'work_notes' ? 'work_note' : 'comment',
						text: entry.value,
						created_by: entry.sys_created_by,
						created_on: entry.sys_created_on,
					}));
				}
			} catch (error) {
				journalError = error;
			}
			// sys_journal_field has its own ACLs: integration users often see none of
			// its rows while they can read the record's journal fields themselves.
			const fromRecord = await journalFromRecord(ctx, table, sysId, journalEntries);
			if (!fromRecord.length && journalError) {
				throw new NodeApiError(ctx.getNode(), journalError as JsonObject);
			}
			return fromRecord;
		});
	}
	if (includeAttachments) {
		out.attachments = await optional('attachments', async () => {
			const response = await serviceNowApiRequest.call(
				ctx,
				'GET',
				`/api/now/attachment?${qs({ sysparm_query: `table_name=${table}^table_sys_id=${sysId}` })}`,
			);
			return ((response.result as IDataObject[]) ?? []).map((a) => ({
				file_name: a.file_name,
				content_type: a.content_type,
				size_bytes: numberOrText(a.size_bytes),
				sys_id: a.sys_id,
				download_link: a.download_link,
			}));
		});
	}
	const binary: IBinaryKeyData = {};
	if (downloadAttachments && Array.isArray(out.attachments)) {
		for (const [index, attachment] of (out.attachments as IDataObject[]).entries()) {
			const fileName = String(attachment.file_name ?? `attachment_${index}`);
			await optional(`attachment ${fileName}`, async () => {
				const data = await serviceNowDownloadAttachment.call(ctx, String(attachment.sys_id));
				const key = `attachment_${index}`;
				binary[key] = await ctx.helpers.prepareBinaryData(
					data,
					fileName,
					attachment.content_type ? String(attachment.content_type) : undefined,
				);
				attachment.binary_property = key;
				return [];
			});
		}
	}
	if (relatedLists.length) {
		const related: IDataObject = {};
		for (const list of relatedLists) {
			const relatedTable = String(list.table ?? '').trim();
			const reference = String(list.referenceField ?? '').trim();
			if (!relatedTable || !reference) continue;
			related[relatedTable] = await optional(`related list ${relatedTable}`, async () => {
				const response = await serviceNowApiRequest.call(
					ctx,
					'GET',
					`${TABLE_API}/${relatedTable}?${qs({
						sysparm_query: `${reference}=${sysId}^ORDERBYDESCsys_updated_on`,
						sysparm_fields: String(list.fields ?? '').replace(/\s/g, ''),
						sysparm_display_value: true,
						sysparm_exclude_reference_link: true,
						sysparm_limit: Number(list.maxRecords) || 20,
					})}`,
				);
				return (response.result as IDataObject[]) ?? [];
			});
		}
		out.related = related;
	}
	if (warnings.length) out.warnings = warnings;
	if (Object.keys(binary).length) binaryOf.set(out, binary);
	return out;
}

/**
 * Evaluate Condition: whether a record matches an encoded query, evaluated by
 * ServiceNow itself (the query scoped to the record's sys_id). The input item
 * goes to True or False unchanged, like an If node; as an AI tool there is one
 * output with `matches`.
 */
async function evaluateCondition(ctx: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const matched: INodeExecutionData[] = [];
	const unmatched: INodeExecutionData[] = [];
	const tool = ctx.isToolExecution();
	const items = ctx.getInputData();
	const route = (i: number, result: IDataObject) => {
		if (tool) matched.push({ json: result, pairedItem: { item: i } });
		else (result.matches ? matched : unmatched).push({ ...items[i], pairedItem: { item: i } });
	};
	for (let i = 0; i < items.length; i++) {
		if (!ctx.continueOnFail()) {
			route(i, await recordMatches(ctx, i));
			continue;
		}
		try {
			route(i, await recordMatches(ctx, i));
		} catch (error) {
			unmatched.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
		}
	}
	return tool ? [matched] : [matched, unmatched];
}

async function recordMatches(ctx: IExecuteFunctions, i: number): Promise<IDataObject> {
	const table = tableName(ctx, i);
	const sysId = String(ctx.getNodeParameter('evaluateSysId', i, '') ?? '').trim();
	if (!/^[0-9a-f]{32}$/i.test(sysId)) {
		throw new NodeOperationError(ctx.getNode(), 'Record Sys ID must be a 32-character sys_id', {
			itemIndex: i,
		});
	}
	const condition = conditionFromParameters((name, fallback) =>
		ctx.getNodeParameter(name, i, fallback),
	);
	if (CHANGE_OPERATORS.test(condition)) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Changes, Changes From and Changes To only exist while a record is saved',
			{ itemIndex: i, description: 'Use them in the trigger or in Wait for Record instead.' },
		);
	}
	const response = await call(
		ctx,
		'GET',
		`${TABLE_API}/${table}?${qs({
			sysparm_query: scopeToRecord(condition, sysId),
			sysparm_fields: 'sys_id',
			sysparm_limit: 1,
			sysparm_no_count: true,
		})}`,
		undefined,
		`evaluate the condition on ${table}`,
		i,
	);
	const matches = ((response.result as IDataObject[]) ?? []).length > 0;
	// No match can also mean the record is missing or unreadable: say so instead of answering false.
	if (!matches) {
		await call(
			ctx,
			'GET',
			`${TABLE_API}/${table}/${sysId}?${qs({ sysparm_fields: 'sys_id' })}`,
			undefined,
			`read ${table} record ${sysId}`,
			i,
		);
	}
	return { matches, table, sys_id: sysId, condition };
}

/** One journal entry's header line as ServiceNow renders it: "<date> <time> - <user> (<field label>)". */
const JOURNAL_HEADER = /^(\S+ \S+) - (.+) \(([^()]+)\)$/;

/**
 * Journal entries from the record's own comments and work_notes display values,
 * for users who can't read sys_journal_field. Dates are in the user's format;
 * created_by is the user's display name.
 */
async function journalFromRecord(
	ctx: IExecuteFunctions,
	table: string,
	sysId: string,
	limit: number,
): Promise<IDataObject[]> {
	const response = await serviceNowApiRequest.call(
		ctx,
		'GET',
		`${TABLE_API}/${table}/${sysId}?${qs({ sysparm_fields: 'comments,work_notes', sysparm_display_value: true })}`,
	);
	const record = (response.result as IDataObject) ?? {};
	const entries = [
		...parseJournal(record.comments, 'comment'),
		...parseJournal(record.work_notes, 'work_note'),
	];
	// Each field lists its newest entry first; a stable sort keeps that order on ties.
	return entries
		.sort((a, b) => journalSortKey(b.created_on).localeCompare(journalSortKey(a.created_on)))
		.slice(0, limit);
}

function parseJournal(text: unknown, type: string): IDataObject[] {
	if (typeof text !== 'string' || !text.trim()) return [];
	const entries: IDataObject[] = [];
	let lines: string[] = [];
	const close = () => {
		const entry = entries[entries.length - 1];
		if (entry) entry.text = lines.join('\n').trim();
		lines = [];
	};
	for (const line of text.split('\n')) {
		const header = JOURNAL_HEADER.exec(line);
		if (header) {
			close();
			entries.push({ type, text: '', created_by: header[2], created_on: header[1] });
		} else {
			lines.push(line);
		}
	}
	close();
	return entries;
}

/** Sortable yyyymmddhhmmss from a date in the user's format (year first, or day/month first). */
function journalSortKey(value: unknown): string {
	const m = /^(\d+)[-/.](\d+)[-/.](\d+)\D+(\d+):(\d+)(?::(\d+))?/.exec(String(value ?? ''));
	if (!m) return '';
	const [a, b, c] = [m[1], m[2], m[3]];
	const year = a.length === 4 ? a : c;
	let [month, day] = a.length === 4 ? [b, c] : [b, a];
	if (a.length !== 4 && Number(b) > 12) [month, day] = [a, b];
	const pad = (v: string | undefined) => (v ?? '0').padStart(2, '0');
	return `${year}${pad(month)}${pad(day)}${pad(m[4])}${pad(m[5])}${pad(m[6])}`;
}

/** execute() for the record actions. */
export async function executeRecordAction(
	ctx: IExecuteFunctions,
	operation: string,
): Promise<INodeExecutionData[][]> {
	switch (operation) {
		case 'upsert':
			return await perItem(ctx, async (i) => await upsert(ctx, i));
		case 'diff':
			return await perItem(ctx, async (i) => await diff(ctx, i));
		case 'search':
			return await perItem(ctx, async (i) => await search(ctx, i));
		case 'bulkWrite':
			return await bulkWrite(ctx);
		case 'aggregate':
			return await perItem(ctx, async (i) => await aggregate(ctx, i));
		case 'evaluateCondition':
			return await evaluateCondition(ctx);
		default:
			return await perItem(ctx, async (i) => await recordContext(ctx, i));
	}
}
