import {
	NodeApiError,
	NodeOperationError,
	type IDataObject,
	type ILoadOptionsFunctions,
	type INodeListSearchResult,
	type INodePropertyOptions,
	type JsonObject,
} from 'n8n-workflow';
import { serviceNowApiRequest, serviceNowCredentials, type ServiceNowContext } from './transport';

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

export async function tableQuery(
	ctx: ServiceNowContext,
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
 * Small per-process cache for picker data that rarely changes (table list,
 * fields per table). Fresh for an hour; after that the old value is still
 * returned at once while one background request refreshes it, for up to a
 * day. Concurrent callers share one in-flight request. In `dev:tunnel` the
 * cache is cleared whenever n8n reloads the rebuilt package.
 */
const FRESH_MS = 60 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;

interface CacheEntry<T> {
	at: number;
	value?: T;
	pending?: Promise<T>;
}

async function cached<T>(
	cache: Map<string, CacheEntry<T>>,
	key: string,
	load: () => Promise<T>,
): Promise<T> {
	const entry = cache.get(key);
	const age = entry ? Date.now() - entry.at : Infinity;
	const refresh = () => {
		const pending = load()
			.then((value) => {
				cache.set(key, { at: Date.now(), value });
				return value;
			})
			.catch((error: unknown) => {
				// Keep serving the old value; drop only the failed refresh.
				const current = cache.get(key);
				if (current?.pending === pending) cache.set(key, { at: current.at, value: current.value });
				throw error;
			});
		cache.set(key, { at: entry?.at ?? 0, value: entry?.value, pending });
		return pending;
	};

	if (entry?.value !== undefined && age < FRESH_MS) return entry.value;
	if (entry?.value !== undefined && age < STALE_MS) {
		if (!entry.pending) refresh().catch(() => undefined);
		return entry.value;
	}
	return await (entry?.pending ?? refresh());
}

const tableCache = new Map<string, CacheEntry<TableRow[]>>();
const TABLE_PAGE_SIZE = 5000;

/** All tables with their parent table, from sys_db_object. */
async function allTables(ctx: ServiceNowContext): Promise<TableRow[]> {
	const { credentials } = await serviceNowCredentials.call(ctx);
	return await cached(tableCache, String(credentials.instanceUrl ?? ''), async () => {
		// Plain columns only: dot-walking to super_class.name makes ServiceNow join
		// every row, and skipping the row count saves another query. Paged, because
		// the Table API caps one response (10,000 rows by default) and instances with
		// many plugins have more tables than that.
		const rows: IDataObject[] = [];
		for (let offset = 0; ; offset += TABLE_PAGE_SIZE) {
			const page = await tableQuery(ctx, 'sys_db_object', {
				sysparm_query: 'ORDERBYsys_id',
				sysparm_fields: 'sys_id,name,label,super_class',
				sysparm_exclude_reference_link: 'true',
				sysparm_no_count: 'true',
				sysparm_limit: TABLE_PAGE_SIZE,
				sysparm_offset: offset,
			});
			rows.push(...page);
			if (page.length < TABLE_PAGE_SIZE || offset > 200_000) break;
		}
		const nameById = new Map(rows.map((r) => [String(r.sys_id), String(r.name ?? '')]));
		return rows.map((r) => ({
			name: String(r.name ?? ''),
			label: String(r.label ?? r.name ?? ''),
			parent: nameById.get(String(r.super_class ?? '')) ?? '',
		}));
	});
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

/**
 * Some tables are hidden from sys_db_object for users without the right roles
 * (HR Service Delivery hides its sn_hr_* tables), yet the UI metadata API still
 * describes them. When the typed text is a full table name that isn't in the
 * list, check that one table directly and offer it.
 */
async function withHiddenTable(
	ctx: ILoadOptionsFunctions,
	needle: string,
	results: INodeListSearchResult['results'],
): Promise<INodeListSearchResult> {
	if (!/^[a-z][a-z0-9_]{3,79}$/.test(needle) || results.some((r) => r.value === needle)) {
		return { results };
	}
	try {
		if ((await fieldsFromMeta(ctx, needle)).length) {
			return {
				results: [
					{
						name: `${needle} (not in table list)`,
						value: needle,
						description:
							'Hidden from the table list for this user; it may also lack read access to its records',
					},
					...results,
				],
			};
		}
	} catch {
		// Not a table, or not readable at all.
	}
	return { results };
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
	return await withHiddenTable(this, needle, results);
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

export interface FieldOption {
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
async function fieldsFromMeta(ctx: ServiceNowContext, table: string): Promise<FieldOption[]> {
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
async function fieldsFromDictionary(ctx: ServiceNowContext, table: string): Promise<FieldOption[]> {
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

const fieldCache = new Map<string, CacheEntry<FieldOption[]>>();

/** Fields of a table including inherited ones, cached like the table list. */
export async function fieldsFor(ctx: ServiceNowContext, table: string): Promise<FieldOption[]> {
	const { credentials } = await serviceNowCredentials.call(ctx);
	const key = `${String(credentials.instanceUrl ?? '')}|${table}`;
	return await cached(fieldCache, key, async () => await loadFields(ctx, table));
}

async function loadFields(ctx: ServiceNowContext, table: string): Promise<FieldOption[]> {
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
	return fields;
}

/**
 * A parameter's current value in a picker, resource locators unwrapped.
 * getCurrentNodeParameter's extractValue throws "Could not find property" for a
 * parameter the current operation doesn't show, and our locators have no
 * extract regex, so the raw value is read instead.
 */
export function currentValue(ctx: ILoadOptionsFunctions, name: string): string {
	const raw = ctx.getCurrentNodeParameter(name) as unknown;
	const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
	return value === undefined || value === null ? '' : String(value).trim();
}

function watchTableOf(ctx: ILoadOptionsFunctions): string {
	return currentValue(ctx, 'table') || currentValue(ctx, 'watchTable');
}

/** The condition row's field definition, or undefined for a typed or dot-walked field. */
async function rowField(ctx: ILoadOptionsFunctions): Promise<FieldOption | undefined> {
	const table = watchTableOf(ctx);
	const element = String(ctx.getCurrentNodeParameter('&field') ?? '').trim();
	if (!table || !element) return undefined;
	return (await fieldsFor(ctx, table)).find((f) => f.element === element);
}

/** loadOptions: field names of the selected table (multi-select lists and match fields). */
export async function getTableFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	return await getWatchTableFields.call(this);
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

/**
 * loadOptions: fields that fit the aggregation row's function. Sum and average
 * need numbers; minimum and maximum also work on dates.
 */
export async function getAggregateFields(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const table = watchTableOf(this);
	if (!table) throw new NodeOperationError(this.getNode(), 'Select a table first');
	const fn = String(this.getCurrentNodeParameter('&function') ?? 'sum');
	const allowed = ['min', 'max'].includes(fn) ? [...NUMERIC_TYPES, ...DATE_TYPES] : NUMERIC_TYPES;
	const fields = (await fieldsFor(this, table)).filter(
		(f) => !f.isChoice && allowed.includes(f.type),
	);
	if (!fields.length) {
		throw new NodeOperationError(
			this.getNode(),
			`No ${['min', 'max'].includes(fn) ? 'number or date' : 'number'} fields on ${table}`,
		);
	}
	return fields
		.map((f) => ({ name: `${f.label} (${f.element})`, value: f.element, description: f.type }))
		.sort((a, b) => a.name.localeCompare(b.name));
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
	const typeBelow = { name: 'Custom Value…', value: '' };
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
	return await withHiddenTable(this, needle, results);
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
	const table = currentValue(this, 'relatedTable') || currentValue(this, 'options.relatedTable');
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
