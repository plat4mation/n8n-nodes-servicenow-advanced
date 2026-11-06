import {
	NodeConnectionTypes,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeProperties,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';
import {
	executeFollowUp,
	executeHitl,
	FOLLOW_UP_OPERATIONS,
	hitlWebhook,
	hitlWebhooks,
	keyValueRows,
	REVIEW_TYPE_BY_OPERATION,
	textParameter,
} from '../shared/hitl';
import { authenticationProperty } from '../shared/transport';
import {
	getAggregateFields,
	getFieldChoices,
	getFieldOperators,
	getTableFields,
	getWatchTableFields,
	searchAllTables,
	searchAssignmentGroups,
	searchRelatedRecords,
	searchWatchTables,
} from '../shared/tableMeta';
import { executeWaitForRecord, waitForRecordWebhook } from '../shared/waitForRecord';
import { watchFields } from '../shared/watchFields';
import {
	catalogProperties,
	executeCatalogAction,
	getCatalogItemVariables,
	searchCatalogItems,
} from './catalog';
import { executeRecordAction, recordProperties } from './records';
import { questionFields, questionsFor } from './questions';

const WAITING_OPERATIONS = ['sendAndWait', 'ask'];
/** Operations that create a HITL request (everything except Wait for Record). */
const REQUEST_OPERATIONS = ['sendAndWait', 'ask', 'reportError'];
const requestOnly = { show: { operation: REQUEST_OPERATIONS } };
const waitForRecordOnly = { operation: ['waitForRecord'] };
const RECORD_OPERATIONS = [
	'upsert',
	'diff',
	'search',
	'bulkWrite',
	'aggregate',
	'getRecordContext',
	'evaluateCondition',
];
const CATALOG_OPERATIONS = ['orderCatalogItem', 'searchKnowledge'];

/**
 * A waiting Approval / Ask step gets one output per outcome plus a catch-all;
 * everything else has one output. Parameters left at their default are not
 * saved, so a missing `operation` means sendAndWait and a missing
 * `waitForCompletion` means true. Keep in sync with OUTCOME_OUTPUTS in hitl.ts.
 */
const outcomeOutputsExpression = `={{ ((p) => {
	const resource = p.resource ?? 'humanReview';
	const operation = p.operation ?? { humanReview: 'sendAndWait', record: 'search' }[resource];
	const wait = p.waitForCompletion ?? true;
if (operation === 'waitForRecord') {
return ['Matched', 'Timed Out'].map((displayName) => ({ type: '${NodeConnectionTypes.Main}', displayName }));
}
if (operation === 'evaluateCondition') {
return ['True', 'False'].map((displayName) => ({ type: '${NodeConnectionTypes.Main}', displayName }));
}
if (!['sendAndWait', 'ask'].includes(operation) || !wait) return ['${NodeConnectionTypes.Main}'];
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
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Human Review', value: 'humanReview' },
					{ name: 'Knowledge', value: 'knowledge' },
					{ name: 'Record', value: 'record' },
					{ name: 'Service Catalog', value: 'catalog' },
				],
				default: 'humanReview',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['humanReview'] } },
				options: [
					{
						name: 'Add Work Note',
						value: 'addWorkNote',
						action: 'Add a work note to a request',
						description: 'Add a note for the reviewers to the open review of a request',
					},
					{
						name: 'Ask Question',
						value: 'ask',
						action: 'Ask a question',
						description: 'Ask a group to answer questions',
					},
					{
						name: 'Cancel Request',
						value: 'cancelRequest',
						action: 'Cancel a request',
						description: 'Withdraw an open request',
					},
					{
						name: 'Get Decision',
						value: 'getDecision',
						action: 'Get the decision on a request',
						description:
							'Read the outcome of a request: open, approved, rejected, answered, declined, resolved, abandoned, expired or cancelled',
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
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['record'] } },
				options: [
					{
						name: 'Aggregate Records',
						value: 'aggregate',
						action: 'Count or aggregate records',
						description:
							'Count, sum, average, minimum or maximum, optionally grouped (Aggregate API)',
					},
					{
						name: 'Bulk Create or Update',
						value: 'bulkWrite',
						action: 'Create or update records in bulk',
						description: 'Send all input items in a few Batch API calls instead of one call each',
					},
					{
						name: 'Compare Record',
						value: 'diff',
						action: 'Compare a record with proposed values',
						description: 'Show what would change, as JSON and as a Markdown table',
					},
					{
						name: 'Create or Update',
						value: 'upsert',
						action: 'Create or update a record',
						description:
							'Create a new record, or update the current one if it already exists (upsert)',
					},
					{
						name: 'Evaluate Condition',
						value: 'evaluateCondition',
						action: 'Check whether a record matches a condition',
						description:
							'Route the item to True or False depending on whether the record matches an encoded query',
					},
					{
						name: 'Get Record With Context',
						value: 'getRecordContext',
						action: 'Get a record with its context',
						description: 'A record plus its comments and work notes, attachments and related lists',
					},
					{
						name: 'Search Records',
						value: 'search',
						action: 'Search records',
						description: 'Find records with the condition builder or an encoded query',
					},
					{
						name: 'Wait for Record',
						value: 'waitForRecord',
						action: 'Wait for a record to change',
						description:
							'Pause the workflow until a record is inserted or updated and matches a condition',
					},
				],
				default: 'search',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['catalog'] } },
				options: [
					{
						name: 'Order Catalog Item',
						value: 'orderCatalogItem',
						action: 'Order a catalog item',
						description:
							"Order through the Service Catalog, so the item's own flows and approvals run",
					},
				],
				default: 'orderCatalogItem',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['knowledge'] } },
				options: [
					{
						name: 'Search Knowledge',
						value: 'searchKnowledge',
						action: 'Search knowledge articles',
						description: 'Find published knowledge articles, optionally with their text',
					},
				],
				default: 'searchKnowledge',
			},
			{
				displayName: 'Correlation ID',
				name: 'correlationId',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. a3f9c1e84b2d47f0a91c5e6d2b7f8340',
				description: 'The correlation_id returned when the request was created',
				displayOptions: { show: { operation: FOLLOW_UP_OPERATIONS } },
			},
			{
				displayName: 'Reason',
				name: 'cancelReason',
				type: 'string',
				typeOptions: { rows: 2 },
				default: '',
				description:
					"Why the request is withdrawn (at most 1000 characters). Stored as the review's closing comment.",
				displayOptions: { show: { operation: ['cancelRequest'] } },
			},
			{
				displayName: 'Work Note',
				name: 'workNote',
				type: 'string',
				typeOptions: { rows: 4 },
				required: true,
				default: '',
				description:
					'Note for the reviewers (at most 4000 characters). Work notes are never sent back with the decision.',
				displayOptions: { show: { operation: ['addWorkNote'] } },
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
				displayOptions: requestOnly,
			},

			// Record actions, catalog and knowledge
			...recordProperties,
			...catalogProperties,

			// Wait for Record
			...watchFields(waitForRecordOnly, 'Wait For', 'update'),
			{
				displayName: 'Only This Record (Sys ID)',
				name: 'recordSysId',
				type: 'string',
				default: '',
				placeholder: 'e.g. 57ecf3ee83589b107b167755eeaad3d4',
				description:
					'Wait for one specific record, e.g. the one that started the workflow. Leave empty to wait for any matching record.',
				displayOptions: { show: waitForRecordOnly },
			},
			{
				displayName: 'Options',
				name: 'waitOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: waitForRecordOnly },
				options: [
					{
						displayName: 'Continue If Already Matching',
						name: 'checkExisting',
						type: 'boolean',
						default: true,
						description:
							'Whether to check for a record that already matches and continue immediately. Skipped for conditions with change operators (Changes, Changes From, Changes To).',
					},
					{
						displayName: 'Stop Waiting After (Hours)',
						name: 'maxWaitHours',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 24,
						description: 'After this, the workflow continues on the Timed Out output',
					},
				],
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
				displayOptions: requestOnly,
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
				displayOptions: requestOnly,
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
		listSearch: {
			searchAllTables,
			searchAssignmentGroups,
			searchRelatedRecords,
			searchWatchTables,
			searchCatalogItems,
		},
		loadOptions: {
			getAggregateFields,
			getWatchTableFields,
			getTableFields,
			getFieldOperators,
			getFieldChoices,
			getCatalogItemVariables,
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		if (this.getNodeParameter('operation', 'sendAndWait') === 'waitForRecord') {
			return await waitForRecordWebhook.call(this);
		}
		return await hitlWebhook.call(this);
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const operation = this.getNodeParameter('operation', 0) as string;
		if (operation === 'waitForRecord') return await executeWaitForRecord(this);
		if (RECORD_OPERATIONS.includes(operation)) return await executeRecordAction(this, operation);
		if (CATALOG_OPERATIONS.includes(operation)) return await executeCatalogAction(this, operation);
		if (FOLLOW_UP_OPERATIONS.includes(operation)) return await executeFollowUp(this, operation);
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
