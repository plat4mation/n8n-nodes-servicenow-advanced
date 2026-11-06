import type { IDisplayOptions, INodeProperties } from 'n8n-workflow';
import { buildEncodedQuery, OPERATORS_WITHOUT_VALUE, type ConditionRow } from './tableMeta';

/**
 * Table + condition fields shared by the On Record Change trigger and the
 * Wait for Record action. The nodes that use them must register the
 * tableMeta loadOptions / listSearch methods (searchWatchTables,
 * getWatchTableFields, getFieldOperators, getFieldChoices).
 */

/**
 * One row of the condition builder. Kept as a named constant: the lint autofix
 * for inline fixedCollection values re-sorts them and drops displayOptions.
 */
export const conditionFields: INodeProperties[] = [
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
			loadOptionsDependsOn: ['watchTable.value', 'table.value'],
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
			loadOptionsDependsOn: ['watchTable.value', 'table.value', '&field'],
		},
		default: 'eq',
		description:
			'Operators that fit the field\'s type. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Value Name or ID',
		name: 'choice',
		type: 'options',
		typeOptions: {
			loadOptionsMethod: 'getFieldChoices',
			loadOptionsDependsOn: ['watchTable.value', 'table.value', '&field'],
		},
		default: '',
		description:
			'The values of choice and true/false fields, or Custom Value to type one. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: { hide: { operator: OPERATORS_WITHOUT_VALUE } },
	},
	{
		displayName: 'Custom Value',
		name: 'value',
		type: 'string',
		default: '',
		placeholder: 'e.g. 2',
		description:
			'The stored value, e.g. a sys_id for reference fields; comma-separated for "is one of"; 10@20 for "between"',
		// Only when "Custom Value…" (empty) is picked above.
		displayOptions: { show: { choice: [''] }, hide: { operator: OPERATORS_WITHOUT_VALUE } },
	},
];

/** The table, operation and condition fields, shown when `show` matches. */
export function watchFields(
	show: NonNullable<IDisplayOptions['show']>,
	operationLabel: string,
	defaultOperation: 'insert' | 'update' | 'insert_or_update',
): INodeProperties[] {
	return [
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
				{ displayName: 'By Name', name: 'id', type: 'string', placeholder: 'e.g. incident' },
			],
			description:
				'Table to watch. Must be an active n8n watch table in ServiceNow (by default task, sys_user and x_pl4_hrlifecycle4_lifecycle_user) or a table that extends one, such as incident.',
			displayOptions: { show },
		},
		{
			displayName: operationLabel,
			name: 'watchOperation',
			type: 'options',
			options: [
				{ name: 'Insert', value: 'insert' },
				{ name: 'Insert or Update', value: 'insert_or_update' },
				{ name: 'Update', value: 'update' },
			],
			default: defaultOperation,
			displayOptions: { show },
		},
		...conditionProperties(
			show,
			'Which records match. No conditions means every insert or update.',
		),
	];
}

/** Condition mode, builder rows and raw encoded query, shown when `show` matches. */
export function conditionProperties(
	show: NonNullable<IDisplayOptions['show']>,
	description: string,
): INodeProperties[] {
	return [
		{
			displayName: 'Condition',
			name: 'conditionMode',
			type: 'options',
			options: [
				{ name: 'Using Condition Builder', value: 'builder' },
				{ name: 'Using Encoded Query', value: 'query' },
			],
			default: 'builder',
			description,
			displayOptions: { show },
		},
		{
			displayName: 'Conditions',
			name: 'conditions',
			type: 'fixedCollection',
			placeholder: 'Add Condition',
			typeOptions: { multipleValues: true, sortable: true },
			default: {},
			displayOptions: { show: { ...show, conditionMode: ['builder'] } },
			options: [{ displayName: 'Condition', name: 'condition', values: conditionFields }],
		},
		{
			displayName: 'Encoded Query',
			name: 'watchCondition',
			type: 'string',
			default: '',
			placeholder: 'e.g. active=true^emailVALCHANGES',
			description:
				'Encoded query the record must match when it is saved. Change operators such as VALCHANGES and CHANGESTO work. Leave empty to match every insert or update.',
			hint: 'Build the filter on a list in ServiceNow and use "Copy query"',
			displayOptions: { show: { ...show, conditionMode: ['query'] } },
		},
	];
}

/** The encoded query from the condition builder or the raw Encoded Query field. */
export function conditionFromParameters(get: (name: string, fallback: unknown) => unknown): string {
	if (get('conditionMode', 'builder') === 'query') {
		const raw = get('watchCondition', '');
		return raw === undefined || raw === null ? '' : String(raw).trim();
	}
	const rows = (get('conditions', {}) as { condition?: ConditionRow[] }).condition ?? [];
	return buildEncodedQuery(rows);
}
