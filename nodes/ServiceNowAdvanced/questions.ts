import {
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeProperties,
} from 'n8n-workflow';

/** Question builder for the "Ask Question" operation of the HITL API. */

type QuestionType =
	| 'string'
	| 'text'
	| 'integer'
	| 'decimal'
	| 'boolean'
	| 'choice'
	| 'multi_choice'
	| 'date'
	| 'date_time';

interface QuestionRow {
	id?: string;
	label?: string;
	type?: QuestionType;
	mandatory?: boolean;
	help?: string;
	choices?: string;
	maxLength?: string;
	min?: string;
	max?: string;
	minSelections?: string;
	maxSelections?: string;
	defaultValue?: string;
}

const NUMERIC: QuestionType[] = ['integer', 'decimal'];
const WITH_CHOICES: QuestionType[] = ['choice', 'multi_choice'];

/**
 * One question from a builder row. Limits are text fields so "empty" means
 * "not set"; they are only sent for the types the API accepts them on.
 */
function questionFromRow(
	ctx: IExecuteFunctions,
	rawRow: QuestionRow,
	itemIndex: number,
): IDataObject {
	// Expressions in a row can resolve to numbers, booleans or undefined.
	const text = (value: unknown): string =>
		value === undefined || value === null ? '' : String(value).trim();
	const row: QuestionRow = {
		...rawRow,
		id: text(rawRow.id),
		label: text(rawRow.label),
		help: text(rawRow.help),
		choices: text(rawRow.choices),
		maxLength: text(rawRow.maxLength),
		min: text(rawRow.min),
		max: text(rawRow.max),
		minSelections: text(rawRow.minSelections),
		maxSelections: text(rawRow.maxSelections),
		defaultValue: text(rawRow.defaultValue),
	};
	const id = row.id ?? '';
	const type = row.type ?? 'string';
	const fail = (message: string) =>
		new NodeOperationError(ctx.getNode(), `Question "${id}": ${message}`, { itemIndex });
	const toNumber = (value: string | undefined, field: string): number | undefined => {
		if (value === undefined || value.trim() === '') return undefined;
		const num = Number(value);
		if (!Number.isFinite(num)) throw fail(`${field} is not a number`);
		return num;
	};

	const question: IDataObject = { id, label: (row.label ?? '').trim() || id, type };
	if (row.mandatory) question.mandatory = true;
	if (row.help?.trim()) question.help = row.help.trim();

	let choiceValues: string[] = [];
	if (WITH_CHOICES.includes(type)) {
		const choices = (row.choices ?? '')
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const eq = line.indexOf('=');
				const value = (eq === -1 ? line : line.slice(0, eq)).trim();
				const label = (eq === -1 ? line : line.slice(eq + 1)).trim() || value;
				return { value, label };
			});
		if (choices.length < 2) throw fail('needs at least two choices');
		question.choices = choices;
		choiceValues = choices.map((c) => c.value);
	}

	if (type === 'string' || type === 'text') {
		const maxLength = toNumber(row.maxLength, 'Max Length');
		if (maxLength !== undefined) question.max_length = maxLength;
	}
	if (NUMERIC.includes(type)) {
		const min = toNumber(row.min, 'Min');
		const max = toNumber(row.max, 'Max');
		if (min !== undefined) question.min = min;
		if (max !== undefined) question.max = max;
	}
	if (type === 'multi_choice') {
		const minSel = toNumber(row.minSelections, 'Min Selections');
		const maxSel = toNumber(row.maxSelections, 'Max Selections');
		if (minSel !== undefined) question.min_selections = minSel;
		if (maxSel !== undefined) question.max_selections = maxSel;
	}

	const def = row.defaultValue?.trim();
	if (def) {
		if (NUMERIC.includes(type)) question.default = toNumber(def, 'Default Answer');
		else if (type === 'boolean') question.default = def.toLowerCase() === 'true';
		else if (type === 'multi_choice') question.default = def.split(',').map((v) => v.trim());
		else question.default = def;
		if (type === 'choice' && !choiceValues.includes(def)) {
			throw fail('Default Answer is not one of the choice values');
		}
	}
	return question;
}

/**
 * Fields of one question, in the order a person fills them in. Kept as a
 * named list: the lint autofix for inline fixedCollection values sorts them
 * alphabetically and drops their displayOptions.
 * Each limit only shows for the question types the HITL API accepts it on.
 */
export const questionFields: INodeProperties[] = [
	{
		displayName: 'ID',
		name: 'id',
		type: 'string',
		default: '',
		placeholder: 'e.g. gl_account',
		description:
			'Key of the answer in the result. Lowercase letters, digits and underscores, at most 40 characters.',
	},
	{
		displayName: 'Label',
		name: 'label',
		type: 'string',
		default: '',
		placeholder: 'e.g. GL account',
	},
	{
		displayName: 'Type',
		name: 'type',
		type: 'options',
		options: [
			{ name: 'Boolean', value: 'boolean' },
			{ name: 'Choice', value: 'choice' },
			{ name: 'Date', value: 'date' },
			{ name: 'Date Time', value: 'date_time' },
			{ name: 'Decimal', value: 'decimal' },
			{ name: 'Integer', value: 'integer' },
			{ name: 'Long Text', value: 'text' },
			{ name: 'Multiple Choice', value: 'multi_choice' },
			{ name: 'Short Text', value: 'string' },
		],
		default: 'string',
	},
	{
		displayName: 'Mandatory',
		name: 'mandatory',
		type: 'boolean',
		default: false,
		description: 'Whether the reviewer must answer this question',
	},
	{
		displayName: 'Help Text',
		name: 'help',
		type: 'string',
		default: '',
	},
	{
		displayName: 'Choices',
		name: 'choices',
		type: 'string',
		typeOptions: { rows: 4 },
		default: '',
		placeholder: 'e.g. 6100=6100 Consultancy',
		description: 'One choice per line as value=Label (at least two)',
		displayOptions: { show: { type: ['choice', 'multi_choice'] } },
	},
	{
		displayName: 'Max Length',
		name: 'maxLength',
		type: 'string',
		default: '',
		description: 'At most 255 for short text and 4000 for long text',
		displayOptions: { show: { type: ['string', 'text'] } },
	},
	{
		displayName: 'Min',
		name: 'min',
		type: 'string',
		default: '',
		description: 'Lowest allowed value. A whole number for integers.',
		displayOptions: { show: { type: ['integer', 'decimal'] } },
	},
	{
		displayName: 'Max',
		name: 'max',
		type: 'string',
		default: '',
		description: 'Highest allowed value. A whole number for integers.',
		displayOptions: { show: { type: ['integer', 'decimal'] } },
	},
	{
		displayName: 'Min Selections',
		name: 'minSelections',
		type: 'string',
		default: '',
		displayOptions: { show: { type: ['multi_choice'] } },
	},
	{
		displayName: 'Max Selections',
		name: 'maxSelections',
		type: 'string',
		default: '',
		displayOptions: { show: { type: ['multi_choice'] } },
	},
	{
		displayName: 'Default Answer',
		name: 'defaultValue',
		type: 'string',
		default: '',
		description:
			'Pre-filled answer. Dates as YYYY-MM-DD, date times as ISO 8601, multiple choice as comma-separated values, booleans as true or false.',
	},
];

/** The `questions` array for one item, from the builder rows or the JSON field. */
export function questionsFor(ctx: IExecuteFunctions, itemIndex: number): IDataObject[] {
	const mode = ctx.getNodeParameter('questionsMode', itemIndex, 'fields') as string;
	let questions: unknown;
	if (mode === 'json') {
		const raw = ctx.getNodeParameter('questionsJson', itemIndex) as string | unknown[];
		try {
			questions = typeof raw === 'string' ? JSON.parse(raw) : raw;
		} catch {
			throw new NodeOperationError(ctx.getNode(), 'Questions JSON is not valid JSON', {
				itemIndex,
			});
		}
	} else {
		const rows =
			(ctx.getNodeParameter('questions', itemIndex, {}) as { question?: QuestionRow[] }).question ??
			[];
		questions = rows.map((row) => questionFromRow(ctx, row, itemIndex));
	}
	if (!Array.isArray(questions) || questions.length === 0) {
		throw new NodeOperationError(ctx.getNode(), 'Add at least one question', { itemIndex });
	}
	return questions as IDataObject[];
}
