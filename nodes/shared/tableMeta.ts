import {
	NodeApiError,
	NodeOperationError,
	type IDataObject,
	type ILoadOptionsFunctions,
	type INodeListSearchResult,
	type INodePropertyOptions,
	type JsonObject,
} from 'n8n-workflow';
import { serviceNowApiRequest, serviceNowCredentials } from './transport';

/**
 * Lookups through standard ServiceNow APIs for the node pickers: tables
 * (sys_db_object), fields (UI metadata API, sys_dictionary fallback), choices
 * (UI metadata, sys_choice fallback), groups and records. Every picker also
 * accepts a typed value, so missing read access never blocks a workflow.
 */

/** Default n8n watch tables in the x_pl4_n8n app; tables extending them are allowed too. */
export const WATCH_ROOT_TABLES = ['task', 'sys_user', 'x_pl4_hrlifecycle4_lifecycle_user'];

interface TableRow {
	name: string;
	label: string;
	parent: string;
}

async function tableQuery(
	ctx: ILoadOptionsFunctions,
	table: string,
	qs: IDataObject,
): Promise<IDataObject[]> {
	const query = Object.entries(qs)
		.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
		.join('&');
	try {
		const response = await serviceNowApiRequest.call(
			ctx,
			'GET',
			`/api/now/table/${table}?${query}`,
		);
		return (response.result as IDataObject[]) ?? [];
	} catch (error) {
		throw new NodeApiError(ctx.getNode(), error as JsonObject, {
			message: `Could not read ${table} from ServiceNow`,
			description: `The ServiceNow user needs read access to ${table}. You can still enter the table name and an encoded query manually.`,
		});
	}
}

/**
 * sys_db_object per credential, kept for a few minutes: the table picker calls
 * allTables on every keystroke, and the full list can be thousands of rows.
 */
const TABLE_CACHE_MS = 5 * 60 * 1000;
const tableCache = new Map<string, { at: number; tables: TableRow[] }>();

/** All tables with their parent table, from sys_db_object. */
async function allTables(ctx: ILoadOptionsFunctions): Promise<TableRow[]> {
	const { credentials } = await serviceNowCredentials.call(ctx);
	const key = String(credentials.instanceUrl ?? '');
	const cached = tableCache.get(key);
	if (cached && Date.now() - cached.at < TABLE_CACHE_MS) return cached.tables;

	const rows = await tableQuery(ctx, 'sys_db_object', {
		sysparm_fields: 'name,label,super_class.name',
		sysparm_exclude_reference_link: 'true',
		sysparm_limit: 20000,
	});
	const tables = rows.map((r) => ({
		name: String(r.name ?? ''),
		label: String(r.label ?? r.name ?? ''),
		parent: String(r['super_class.name'] ?? ''),
	}));
	tableCache.set(key, { at: Date.now(), tables });
	return tables;
}

/** The roots plus every table that extends one of them, at any depth. */
function descendantsOf(tables: TableRow[], roots: string[]): TableRow[] {
	const children = new Map<string, TableRow[]>();
	for (const t of tables) {
		if (!t.parent) continue;
		const list = children.get(t.parent) ?? [];
		list.push(t);
		children.set(t.parent, list);
	}
	const byName = new Map(tables.map((t) => [t.name, t]));
	const result: TableRow[] = [];
	const seen = new Set<string>();
	const queue = roots.filter((r) => byName.has(r));
	while (queue.length) {
		const name = queue.shift() as string;
		if (seen.has(name)) continue;
		seen.add(name);
		result.push(byName.get(name) as TableRow);
		for (const child of children.get(name) ?? []) queue.push(child.name);
	}
	return result;
}

/** listSearch: watchable tables (the roots and their extensions), filtered by name or label. */
export async function searchWatchTables(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const tables = descendantsOf(await allTables(this), WATCH_ROOT_TABLES);
	const needle = (filter ?? '').trim().toLowerCase();
	const results = tables
		.filter(
			(t) =>
				!needle || t.name.toLowerCase().includes(needle) || t.label.toLowerCase().includes(needle),
		)
		.sort((a, b) => a.label.localeCompare(b.label))
		.map((t) => ({ name: `${t.label} (${t.name})`, value: t.name }));
	return { results };
}

/** The table and all its parent tables, nearest first. */
function ancestry(tables: TableRow[], table: string): string[] {
	const byName = new Map(tables.map((t) => [t.name, t]));
	const chain: string[] = [];
	let current: string | undefined = table;
	while (current && !chain.includes(current)) {
		chain.push(current);
		current = byName.get(current)?.parent || undefined;
	}
	return chain;
}

interface FieldOption {
	element: string;
	label: string;
	type: string;
	from?: string;
	/** Choice values from the metadata API, when the field is a choice field. */
	choices?: Array<{ label: string; value: string }>;
	isChoice?: boolean;
}

/**
 * Fields from the UI metadata API (`/api/now/ui/meta/<table>`). It already
 * includes inherited fields and only needs read access to the table itself,
 * unlike sys_dictionary (often admin-only, and then silently empty).
 */
async function fieldsFromMeta(ctx: ILoadOptionsFunctions, table: string): Promise<FieldOption[]> {
	const response = await serviceNowApiRequest.call(
		ctx,
		'GET',
		`/api/now/ui/meta/${encodeURIComponent(table)}`,
	);
	const columns = ((response.result as IDataObject)?.columns ?? {}) as Record<string, IDataObject>;
	return Object.entries(columns)
		.filter(([element, col]) => element && !element.startsWith('sys_tags') && col)
		.map(([element, col]) => {
			const choices = Array.isArray(col.choices)
				? (col.choices as IDataObject[])
						.filter((c) => c && c.value !== undefined && c.value !== '')
						.map((c) => ({ label: String(c.label ?? c.value), value: String(c.value) }))
				: undefined;
			return {
				element,
				label: String(col.label ?? element),
				type: String(col.internal_type ?? col.type ?? ''),
				choices: choices?.length ? choices : undefined,
				isChoice: Number(col.choice ?? 0) > 0 || !!choices?.length,
			};
		})
		.filter((f) => f.type !== 'collection');
}

/** Fallback: sys_dictionary for the table's whole ancestry; a child's definition wins. */
async function fieldsFromDictionary(
	ctx: ILoadOptionsFunctions,
	table: string,
): Promise<FieldOption[]> {
	const chain = ancestry(await allTables(ctx), table);
	const rows = await tableQuery(ctx, 'sys_dictionary', {
		sysparm_query: `nameIN${chain.join(',')}^elementISNOTEMPTY^internal_type!=collection`,
		sysparm_fields: 'name,element,column_label,internal_type',
		sysparm_exclude_reference_link: 'true',
		sysparm_limit: 5000,
	});
	const rank = new Map(chain.map((name, i) => [name, i]));
	const fields = new Map<string, IDataObject>();
	for (const row of rows) {
		const element = String(row.element ?? '');
		const existing = fields.get(element);
		if (!existing || (rank.get(String(row.name)) ?? 99) < (rank.get(String(existing.name)) ?? 99)) {
			fields.set(element, row);
		}
	}
	return [...fields.values()].map((f) => ({
		element: String(f.element),
		label: String(f.column_label || f.element),
		type: String(f.internal_type ?? ''),
		from: f.name !== table ? String(f.name) : undefined,
	}));
}

const fieldCache = new Map<string, { at: number; fields: FieldOption[] }>();

/** Fields of a table including inherited ones, cached like the table list. */
async function fieldsFor(ctx: ILoadOptionsFunctions, table: string): Promise<FieldOption[]> {
	const { credentials } = await serviceNowCredentials.call(ctx);
	const key = `${String(credentials.instanceUrl ?? '')}|${table}`;
	const cached = fieldCache.get(key);
	if (cached && Date.now() - cached.at < TABLE_CACHE_MS) return cached.fields;

	let fields: FieldOption[] = [];
	let metaError: string | undefined;
	try {
		fields = await fieldsFromMeta(ctx, table);
	} catch (error) {
		metaError = (error as Error).message;
	}
	if (!fields.length) {
		try {
			fields = await fieldsFromDictionary(ctx, table);
		} catch {
			// Reported below together with the metadata error.
		}
	}
	if (!fields.length) {
		throw new NodeOperationError(ctx.getNode(), `No fields found for table "${table}"`, {
			description: `The ServiceNow user needs read access to the table (UI metadata API) or to sys_dictionary.${metaError ? ` Metadata API: ${metaError}` : ''} You can still type a field name as an expression or use an encoded query.`,
		});
	}
	fieldCache.set(key, { at: Date.now(), fields });
	return fields;
}

function watchTableOf(ctx: ILoadOptionsFunctions): string {
	return String(ctx.getCurrentNodeParameter('watchTable', { extractValue: true }) ?? '').trim();
}

/** The condition row's field definition, or undefined for a typed or dot-walked field. */
async function rowField(ctx: ILoadOptionsFunctions): Promise<FieldOption | undefined> {
	const table = watchTableOf(ctx);
	const element = String(ctx.getCurrentNodeParameter('&field') ?? '').trim();
	if (!table || !element) return undefined;
	return (await fieldsFor(ctx, table)).find((f) => f.element === element);
}

/** loadOptions: fields of the selected table, including inherited ones. */
export async function getWatchTableFields(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const table = watchTableOf(this);
	if (!table) {
		throw new NodeOperationError(this.getNode(), 'Select a table first');
	}
	return (await fieldsFor(this, table))
		.map((f) => ({
			name: `${f.label} (${f.element})`,
			value: f.element,
			description: `${f.isChoice ? 'choice' : f.type}${f.from ? ` · from ${f.from}` : ''}`,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Encoded query operators. ServiceNow has no API listing them; this is the set
 * the list filter offers, plus the change operators that only work on watched
 * saves (VALCHANGES, CHANGESFROM, CHANGESTO).
 */
export const QUERY_OPERATORS: Array<{
	name: string;
	value: string;
	op: string;
	needsValue: boolean;
	description?: string;
}> = [
	{ name: 'Is', value: 'eq', op: '=', needsValue: true },
	{ name: 'Is Not', value: 'neq', op: '!=', needsValue: true },
	{
		name: 'Is One Of',
		value: 'in',
		op: 'IN',
		needsValue: true,
		description: 'Comma-separated values',
	},
	{
		name: 'Is Not One Of',
		value: 'notIn',
		op: 'NOT IN',
		needsValue: true,
		description: 'Comma-separated values',
	},
	{ name: 'Contains', value: 'like', op: 'LIKE', needsValue: true },
	{ name: 'Does Not Contain', value: 'notLike', op: 'NOTLIKE', needsValue: true },
	{ name: 'Starts With', value: 'startsWith', op: 'STARTSWITH', needsValue: true },
	{ name: 'Ends With', value: 'endsWith', op: 'ENDSWITH', needsValue: true },
	{ name: 'Is Empty', value: 'isEmpty', op: 'ISEMPTY', needsValue: false },
	{ name: 'Is Not Empty', value: 'isNotEmpty', op: 'ISNOTEMPTY', needsValue: false },
	{ name: 'Less Than', value: 'lt', op: '<', needsValue: true },
	{ name: 'Less Than or Equal', value: 'lte', op: '<=', needsValue: true },
	{ name: 'Greater Than', value: 'gt', op: '>', needsValue: true },
	{ name: 'Greater Than or Equal', value: 'gte', op: '>=', needsValue: true },
	{
		name: 'Between',
		value: 'between',
		op: 'BETWEEN',
		needsValue: true,
		description: 'Two values separated by @, e.g. 10@20',
	},
	{
		name: 'Is Same As Field',
		value: 'sameAs',
		op: 'SAMEAS',
		needsValue: true,
		description: 'Name of another field',
	},
	{
		name: 'Is Different From Field',
		value: 'notSameAs',
		op: 'NSAMEAS',
		needsValue: true,
		description: 'Name of another field',
	},
	{
		name: 'Changes',
		value: 'changes',
		op: 'VALCHANGES',
		needsValue: false,
		description: 'The field changed in this save',
	},
	{
		name: 'Changes From',
		value: 'changesFrom',
		op: 'CHANGESFROM',
		needsValue: true,
		description: 'The field had this value before the save',
	},
	{
		name: 'Changes To',
		value: 'changesTo',
		op: 'CHANGESTO',
		needsValue: true,
		description: 'The field got this value in this save',
	},
];

export const OPERATORS_WITHOUT_VALUE = QUERY_OPERATORS.filter((o) => !o.needsValue).map(
	(o) => o.value,
);

const CHANGE_OPERATORS = ['changes', 'changesFrom', 'changesTo'];
const NUMERIC_TYPES = [
	'integer',
	'decimal',
	'float',
	'longint',
	'currency',
	'price',
	'numeric',
	'percent_complete',
	'counter',
	'auto_increment',
];
const DATE_TYPES = [
	'glide_date',
	'glide_date_time',
	'due_date',
	'date',
	'datetime',
	'glide_time',
	'calendar_date_time',
];
const REFERENCE_TYPES = ['reference', 'document_id', 'glide_list'];

/** Operator values that make sense for a field; all operators when the type is unknown. */
export function operatorsForField(
	field: { type: string; isChoice?: boolean } | undefined,
): string[] {
	if (!field) return QUERY_OPERATORS.map((o) => o.value);
	const base = ['eq', 'neq'];
	const empty = ['isEmpty', 'isNotEmpty'];
	if (field.type === 'boolean') return [...base, ...CHANGE_OPERATORS];
	if (field.isChoice) return [...base, 'in', 'notIn', ...empty, ...CHANGE_OPERATORS];
	if (REFERENCE_TYPES.includes(field.type)) {
		return [...base, 'in', 'notIn', ...empty, 'sameAs', 'notSameAs', ...CHANGE_OPERATORS];
	}
	if (NUMERIC_TYPES.includes(field.type)) {
		return [
			...base,
			'in',
			'notIn',
			'lt',
			'lte',
			'gt',
			'gte',
			'between',
			...empty,
			...CHANGE_OPERATORS,
		];
	}
	if (DATE_TYPES.includes(field.type)) {
		return [...base, 'lt', 'lte', 'gt', 'gte', 'between', ...empty, 'changes'];
	}
	return QUERY_OPERATORS.filter(
		(o) => !['lt', 'lte', 'gt', 'gte', 'between'].includes(o.value),
	).map((o) => o.value);
}

/** loadOptions: operators that fit the condition row's field. */
export async function getFieldOperators(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	let field: FieldOption | undefined;
	try {
		field = await rowField(this);
	} catch {
		// Unknown field type: offer every operator.
	}
	const allowed = operatorsForField(field);
	return QUERY_OPERATORS.filter((o) => allowed.includes(o.value)).map(
		({ name, value, description }) => ({
			name,
			value,
			description,
		}),
	);
}

/** Choice values from sys_choice for a field and its parent tables (nearest wins). */
async function choicesFromSysChoice(
	ctx: ILoadOptionsFunctions,
	table: string,
	element: string,
): Promise<Array<{ label: string; value: string }>> {
	const chain = ancestry(await allTables(ctx), table);
	const rows = await tableQuery(ctx, 'sys_choice', {
		sysparm_query: `nameIN${chain.join(',')}^element=${element}^inactive=false^ORDERBYsequence`,
		sysparm_fields: 'name,label,value',
		sysparm_limit: 500,
	});
	const nearest = chain.find((name) => rows.some((r) => r.name === name));
	return rows
		.filter((r) => r.name === nearest)
		.map((r) => ({ label: String(r.label ?? r.value), value: String(r.value ?? '') }));
}

/** loadOptions: stored values for choice and boolean fields; empty for other fields. */
export async function getFieldChoices(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const typeBelow = { name: '— Type the Value Below —', value: '' };
	let field: FieldOption | undefined;
	try {
		field = await rowField(this);
	} catch {
		return [typeBelow];
	}
	if (!field) return [typeBelow];
	if (field.type === 'boolean') {
		return [typeBelow, { name: 'True', value: 'true' }, { name: 'False', value: 'false' }];
	}
	if (!field.isChoice) return [typeBelow];
	let choices = field.choices ?? [];
	if (!choices.length) {
		try {
			choices = await choicesFromSysChoice(this, watchTableOf(this), field.element);
		} catch {
			// No read access to sys_choice: the value can still be typed.
		}
	}
	return [typeBelow, ...choices.map((c) => ({ name: `${c.label} (${c.value})`, value: c.value }))];
}

export interface ConditionRow {
	join?: 'and' | 'or' | 'newQuery';
	field?: string;
	operator?: string;
	/** Picked from the Choice dropdown; wins over the typed value. */
	choice?: string;
	value?: string;
}

/**
 * Builder rows -> encoded query. `^` joins AND, `^OR` joins OR, `^NQ` starts a
 * new OR-ed query. A `^` inside a value is escaped as `^^`.
 */
export function buildEncodedQuery(rows: ConditionRow[]): string {
	const parts: string[] = [];
	for (const row of rows) {
		const field = String(row.field ?? '').trim();
		const operator = QUERY_OPERATORS.find((o) => o.value === row.operator);
		if (!field || !operator) continue;
		const raw = String(row.choice ?? '').trim() || String(row.value ?? '');
		const value = operator.needsValue ? raw.replace(/\^/g, '^^') : '';
		const term = `${field}${operator.op}${value}`;
		if (!parts.length) parts.push(term);
		else parts.push(`${row.join === 'or' ? '^OR' : row.join === 'newQuery' ? '^NQ' : '^'}${term}`);
	}
	return parts.join('');
}

/** listSearch: every table, for the Related Record table picker. */
export async function searchAllTables(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const needle = (filter ?? '').trim().toLowerCase();
	const results = (await allTables(this))
		.filter(
			(t) =>
				!needle || t.name.toLowerCase().includes(needle) || t.label.toLowerCase().includes(needle),
		)
		.sort((a, b) => a.label.localeCompare(b.label))
		.slice(0, 200)
		.map((t) => ({ name: `${t.label} (${t.name})`, value: t.name }));
	return { results };
}

/** listSearch: active assignment groups by name. */
export async function searchAssignmentGroups(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const needle = (filter ?? '').trim();
	const rows = await tableQuery(this, 'sys_user_group', {
		sysparm_query: `active=true${needle ? `^nameLIKE${needle}` : ''}^ORDERBYname`,
		sysparm_fields: 'sys_id,name,description',
		sysparm_limit: 100,
	});
	return {
		results: rows.map((r) => ({
			name: String(r.name ?? r.sys_id),
			value: String(r.sys_id),
			description: r.description ? String(r.description) : undefined,
		})),
	};
}

/**
 * listSearch: records of the chosen related table, by number or short
 * description (or name, for tables without a number). Value is the sys_id.
 */
export async function searchRelatedRecords(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const table = String(
		this.getCurrentNodeParameter('relatedTable', { extractValue: true }) ??
			this.getCurrentNodeParameter('options.relatedTable', { extractValue: true }) ??
			'',
	).trim();
	if (!table) {
		throw new NodeOperationError(this.getNode(), 'Select the related record table first');
	}
	const needle = (filter ?? '').trim();
	const rows = await tableQuery(this, table, {
		sysparm_query: `${needle ? `numberLIKE${needle}^ORshort_descriptionLIKE${needle}^ORnameLIKE${needle}` : ''}^ORDERBYDESCsys_updated_on`,
		sysparm_fields: 'sys_id,number,short_description,name',
		sysparm_limit: 50,
	});
	return {
		results: rows.map((r) => {
			const title = String(r.number || r.name || r.sys_id);
			const detail = r.short_description ? ` – ${String(r.short_description)}` : '';
			return { name: `${title}${detail}`.slice(0, 120), value: String(r.sys_id) };
		}),
	};
}
