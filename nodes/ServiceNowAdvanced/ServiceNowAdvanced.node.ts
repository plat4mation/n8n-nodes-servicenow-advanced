import {
	NodeConnectionTypes,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeProperties,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';
import {
	executeHitl,
	hitlWebhook,
	hitlWebhooks,
	keyValueRows,
	REVIEW_TYPE_BY_OPERATION,
	textParameter,
} from '../shared/hitl';
import { authenticationProperty } from '../shared/transport';
import { searchAllTables, searchAssignmentGroups, searchRelatedRecords } from '../shared/tableMeta';
import { questionFields, questionsFor } from './questions';

const WAITING_OPERATIONS = ['sendAndWait', 'ask'];

/**
 * A waiting Approval / Ask step gets one output per outcome plus a catch-all;
 * everything else has one output. Parameters left at their default are not
 * saved, so a missing `operation` means sendAndWait and a missing
 * `waitForCompletion` means true. Keep in sync with OUTCOME_OUTPUTS in hitl.ts.
 */
const outcomeOutputsExpression = `={{ ((p) => {
	const operation = p.operation ?? 'sendAndWait';
	const wait = p.waitForCompletion ?? true;
	if (operation === 'reportError' || !wait) return ['${NodeConnectionTypes.Main}'];
	const names = operation === 'ask'
		? ['Answered', 'Declined', 'Expired / Other']
		: ['Approved', 'Rejected', 'Expired / Other'];
	return names.map((displayName) => ({ type: '${NodeConnectionTypes.Main}', displayName }));
})($parameter) }}` as `={{${string}}}`;

/**
 * Related record table and record. Both are pickers that also take a typed
 * value. Records found in the list are sent by sys_id; typed values by number
 * or sys_id depending on the mode.
 */
const relatedRecordFields = (
	required: boolean,
	displayOptions: INodeProperties['displayOptions'],
): INodeProperties[] => [
	{
		displayName: 'Related Record Table',
		name: 'relatedTable',
		type: 'resourceLocator',
		required,
		default: { mode: 'list', value: '' },
		description:
			'Table of the ServiceNow record the review is about. It must be allowed for the requester system.',
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchAllTables', searchable: true },
			},
			{ displayName: 'By Name', name: 'id', type: 'string', placeholder: 'e.g. sc_req_item' },
		],
		displayOptions,
	},
	{
		displayName: 'Related Record',
		name: 'relatedValue',
		type: 'resourceLocator',
		required,
		default: { mode: 'list', value: '' },
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchRelatedRecords', searchable: true },
			},
			{
				displayName: 'By Number',
				name: 'number',
				type: 'string',
				placeholder: 'e.g. RITM0012345',
			},
			{
				displayName: 'By Sys ID',
				name: 'id',
				type: 'string',
				placeholder: 'e.g. 57ecf3ee83589b107b167755eeaad3d4',
				validation: [
					{
						type: 'regex',
						properties: { regex: '^[0-9a-f]{32}$', errorMessage: 'Not a 32-character sys_id' },
					},
				],
			},
		],
		displayOptions,
	},
];

const askOnly = { show: { operation: ['ask'] } };
const errorOnly = { show: { operation: ['reportError'] } };

export class ServiceNowAdvanced implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ServiceNow Advanced',
		name: 'serviceNowAdvanced',
		icon: {
			light: 'file:../../icons/servicenow.svg',
			dark: 'file:../../icons/servicenow.dark.svg',
		},
		group: ['transform'],
		version: 1,
		subtitle:
			'={{ {"sendAndWait":"Request an approval","ask":"Ask a question","reportError":"Report an error"}[$parameter["operation"]] }}',
		description:
			'Ask a ServiceNow group for an approval, answers or a fix, optionally waiting for the result',
		defaults: {
			name: 'ServiceNow Advanced',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: outcomeOutputsExpression,
		usableAsTool: true,
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
		webhooks: hitlWebhooks,
		// The editor hides any parameter that a credential-related field's
		// displayOptions depend on, so `authentication` must not get show conditions.
		properties: [
			authenticationProperty,
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Ask Question',
						value: 'ask',
						action: 'Ask a question',
						description: 'Ask a group to answer questions',
					},
					{
						name: 'Report Error',
						value: 'reportError',
						action: 'Report an error',
						description: 'Hand a problem on a ServiceNow record to a group to fix',
					},
					{
						name: 'Request Approval',
						value: 'sendAndWait',
						action: 'Request an approval',
						description: 'Ask a group to approve or reject something',
					},
				],
				default: 'sendAndWait',
			},
			{
				displayName: 'Subject',
				name: 'subject',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. Approve purchase order PO-2026-1188 (EUR 48,000)',
				description:
					'Short description of the review task. The first 160 characters become its short description.',
			},

			// Ask Question
			{
				displayName: 'Define Questions',
				name: 'questionsMode',
				type: 'options',
				options: [
					{ name: 'Using Fields Below', value: 'fields' },
					{ name: 'Using JSON', value: 'json' },
				],
				default: 'fields',
				displayOptions: askOnly,
			},
			{
				displayName: 'Questions',
				name: 'questions',
				type: 'fixedCollection',
				placeholder: 'Add Question',
				typeOptions: { multipleValues: true, sortable: true },
				default: {},
				displayOptions: { show: { operation: ['ask'], questionsMode: ['fields'] } },
				options: [{ displayName: 'Question', name: 'question', values: questionFields }],
			},
			{
				displayName: 'Questions JSON',
				name: 'questionsJson',
				type: 'json',
				required: true,
				default:
					'[\n  { "id": "reviewer_note", "label": "Note", "type": "text", "max_length": 1000 }\n]',
				displayOptions: { show: { operation: ['ask'], questionsMode: ['json'] } },
				description: 'Array of questions in the HITL API format',
			},

			// Report Error
			{
				displayName: 'Error Message',
				name: 'errorMessage',
				type: 'string',
				typeOptions: { rows: 4 },
				required: true,
				default: '',
				placeholder: 'e.g. Vendor API returned 403: seat limit reached',
				description: 'What went wrong, at most 4000 characters',
				displayOptions: errorOnly,
			},
			{
				displayName: 'Error Code',
				name: 'errorCode',
				type: 'string',
				default: '',
				placeholder: 'e.g. VENDOR_403',
				displayOptions: errorOnly,
			},
			{
				displayName: 'Failed Step',
				name: 'errorStep',
				type: 'string',
				default: '',
				placeholder: 'e.g. Provision licence',
				description: 'Name of the step that failed',
				displayOptions: errorOnly,
			},
			{
				displayName: 'Error Details',
				name: 'errorDetails',
				type: 'fixedCollection',
				placeholder: 'Add Detail',
				typeOptions: { multipleValues: true, sortable: true },
				default: {},
				description: 'Extra key/value data shown to whoever fixes the problem',
				displayOptions: errorOnly,
				options: [
					{
						displayName: 'Detail',
						name: 'field',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			...relatedRecordFields(true, errorOnly),

			// All operations
			{
				displayName: 'Context',
				name: 'contextMode',
				type: 'options',
				options: [
					{ name: 'None', value: 'none' },
					{ name: 'Using Fields Below', value: 'fields' },
					{ name: 'Using JSON', value: 'json' },
				],
				default: 'none',
				description: 'Key/value data shown to the reviewer. Display only.',
			},
			{
				displayName: 'Context Fields',
				name: 'contextFields',
				type: 'fixedCollection',
				placeholder: 'Add Field',
				typeOptions: { multipleValues: true, sortable: true },
				default: {},
				displayOptions: { show: { contextMode: ['fields'] } },
				options: [
					{
						displayName: 'Field',
						name: 'field',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			{
				displayName: 'Context JSON',
				name: 'contextJson',
				type: 'json',
				required: true,
				default: '{}',
				displayOptions: { show: { contextMode: ['json'] } },
				description: 'Context as a JSON object',
			},
			{
				displayName: 'Wait for Completion',
				name: 'waitForCompletion',
				type: 'boolean',
				default: true,
				displayOptions: { show: { operation: WAITING_OPERATIONS }, hide: { '@tool': [true] } },
				description:
					'Whether to pause the workflow until ServiceNow sends back the decision or answers. Only the first input item is processed when waiting. As an AI agent tool the node only sends the request; use the Human review variant to gate other tools on an approval.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Assignment Group',
						name: 'assignmentGroup',
						type: 'resourceLocator',
						default: { mode: 'list', value: '' },
						description:
							"Group that works the review. Defaults to the requester system's group. For approvals it needs at least one active member.",
						modes: [
							{
								displayName: 'From List',
								name: 'list',
								type: 'list',
								typeOptions: { searchListMethod: 'searchAssignmentGroups', searchable: true },
							},
							{
								displayName: 'By Name or Sys ID',
								name: 'id',
								type: 'string',
								placeholder: 'e.g. Finance Operations',
							},
						],
					},
					{
						displayName: 'Attachments (Binary Fields)',
						name: 'attachments',
						type: 'string',
						default: '',
						placeholder: 'e.g. data, invoice',
						description:
							'Comma-separated binary fields of the input item to attach to the related record before the request is created, so the reviewer sees the files. Needs a related record.',
					},
					{
						displayName: 'Expires At',
						name: 'expiresAt',
						type: 'dateTime',
						default: '',
						description:
							"When the request expires. Defaults to the requester system's expiry. When waiting, n8n gives up 15 minutes after this moment.",
					},
					{
						displayName: 'Include Link to Workflow Run',
						name: 'includeRunLink',
						type: 'boolean',
						default: true,
						description:
							'Whether to add the workflow name and a link to this execution to the context, so the reviewer can see where the request came from',
					},
					...relatedRecordFields(false, { show: { '/operation': WAITING_OPERATIONS } }),
					{
						displayName: 'Stop Waiting After (Hours)',
						name: 'maxWaitHours',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 168,
						displayOptions: { show: { '/operation': WAITING_OPERATIONS } },
						description:
							'When waiting and no Expires At is set: give up after this many hours. ServiceNow never pushes a cancelled request, so without a limit a cancellation would leave the workflow waiting forever.',
					},
				],
			},
		],
	};

	methods = {
		listSearch: { searchAllTables, searchAssignmentGroups, searchRelatedRecords },
	};

	webhook = hitlWebhook;

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const operation = this.getNodeParameter('operation', 0) as string;
		const reviewType = REVIEW_TYPE_BY_OPERATION[operation];

		return await executeHitl(this, reviewType, (i): IDataObject => {
			if (reviewType === 'ask') return { questions: questionsFor(this, i) };
			if (reviewType === 'error') {
				const error: IDataObject = {
					message: textParameter(this, 'errorMessage', i).slice(0, 4000),
				};
				const code = textParameter(this, 'errorCode', i);
				if (code) error.code = code;
				const step = textParameter(this, 'errorStep', i);
				if (step) error.step = step;
				const details = keyValueRows(this, 'errorDetails', i);
				if (Object.keys(details).length) error.details = details;
				return { error };
			}
			return {};
		});
	}
}
