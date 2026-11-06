import {
	NodeApiError,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type ILoadOptionsFunctions,
	type INodeExecutionData,
	type INodeListSearchResult,
	type INodeProperties,
	type INodePropertyOptions,
	type JsonObject,
} from 'n8n-workflow';
import { currentValue } from '../shared/tableMeta';
import {
	describeFailedRequest,
	serviceNowApiRequest,
	serviceNowCredentials,
	statusOf,
} from '../shared/transport';

/**
 * Order Catalog Item (Service Catalog API, `/api/sn_sc/servicecatalog`) and
 * Search Knowledge (Knowledge Management API, `/api/sn_km_api/knowledge`).
 * Ordering through the catalog runs the item's own flows, approvals and
 * fulfilment, unlike writing request records directly.
 */

const CATALOG_API = '/api/sn_sc/servicecatalog';
const KNOWLEDGE_API = '/api/sn_km_api/knowledge';

const show = (operation: string) => ({ show: { operation: [operation] } });

export const catalogProperties: INodeProperties[] = [
	{
		displayName: 'Catalog Item',
		name: 'catalogItem',
		type: 'resourceLocator',
		required: true,
		default: { mode: 'list', value: '' },
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchCatalogItems', searchable: true },
			},
			{
				displayName: 'By Sys ID',
				name: 'id',
				type: 'string',
				placeholder: 'e.g. 060f3afa3731300054b6a3549dbe5d3e',
			},
		],
		displayOptions: show('orderCatalogItem'),
	},
	{
		displayName: 'Variables',
		name: 'variablesMode',
		type: 'options',
		options: [
			{ name: 'Using Fields Below', value: 'fields' },
			{ name: 'Using JSON', value: 'json' },
		],
		default: 'fields',
		displayOptions: show('orderCatalogItem'),
	},
	{
		displayName: 'Variable Values',
		name: 'catalogVariables',
		type: 'fixedCollection',
		placeholder: 'Add Variable',
		typeOptions: { multipleValues: true, sortable: true },
		default: {},
		displayOptions: { show: { operation: ['orderCatalogItem'], variablesMode: ['fields'] } },
		options: [
			{
				displayName: 'Variable',
				name: 'variable',
				values: [
					{
						displayName: 'Variable Name or ID',
						name: 'name',
						type: 'options',
						typeOptions: {
							loadOptionsMethod: 'getCatalogItemVariables',
							loadOptionsDependsOn: ['catalogItem.value'],
						},
						default: '',
						description:
							'Mandatory variables are marked with *. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
						description:
							'Stored value: a sys_id for reference variables, the choice value for choices',
					},
				],
			},
		],
	},
	{
		displayName: 'Variables JSON',
		name: 'catalogVariablesJson',
		type: 'json',
		required: true,
		default: '{\n  "requested_for": ""\n}',
		displayOptions: { show: { operation: ['orderCatalogItem'], variablesMode: ['json'] } },
		description: 'Variable values keyed by variable name',
	},
	{
		displayName: 'Quantity',
		name: 'quantity',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 1,
		displayOptions: show('orderCatalogItem'),
	},
	{
		displayName: 'Options',
		name: 'catalogOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('orderCatalogItem'),
		options: [
			{
				displayName: 'Include Requested Items',
				name: 'includeRequestedItems',
				type: 'boolean',
				default: true,
				description: 'Whether to look up the RITMs created for the request and return them too',
			},
			{
				displayName: 'Requested For (Sys ID)',
				name: 'requestedFor',
				type: 'string',
				default: '',
				placeholder: 'e.g. 62826bf03710200044e0bfc8bcbe5df1',
				description: 'User the request is for; defaults to the credential user',
			},
		],
	},

	// Search Knowledge
	{
		displayName: 'Search Text',
		name: 'knowledgeQuery',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. reset VPN password',
		displayOptions: show('searchKnowledge'),
	},
	{
		displayName: 'Limit',
		name: 'knowledgeLimit',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 100 },
		default: 5,
		description: 'Max number of results to return',
		displayOptions: show('searchKnowledge'),
	},
	{
		displayName: 'Options',
		name: 'knowledgeOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('searchKnowledge'),
		options: [
			{
				displayName: 'Include Article Text',
				name: 'includeContent',
				type: 'boolean',
				default: false,
				description:
					'Whether to fetch each article and add its text (HTML removed), e.g. as context for an AI agent',
			},
			{
				displayName: 'Knowledge Base (Sys ID)',
				name: 'knowledgeBase',
				type: 'string',
				default: '',
				description: 'Only search this knowledge base; comma-separate several',
			},
		],
	},
];

async function call(
	ctx: IExecuteFunctions,
	method: 'GET' | 'POST',
	path: string,
	body: IDataObject | undefined,
	what: string,
	itemIndex: number,
): Promise<IDataObject> {
	try {
		return await serviceNowApiRequest.call(ctx, method, path, body);
	} catch (error) {
		const status = statusOf(error);
		const missingPlugin =
			status === 404
				? ' The API was not found: check that the ServiceNow plugin for it (Service Catalog API / Knowledge Management REST API) is active.'
				: '';
		throw new NodeApiError(ctx.getNode(), error as JsonObject, {
			message: `Could not ${what}${status ? ` (HTTP ${status})` : ''}`,
			description: `${describeFailedRequest(ctx, method, path.split('?')[0], body, error)}${missingPlugin}`,
			itemIndex,
		});
	}
}

/** Search Knowledge through the Table API, for instances without the knowledge API. */
async function searchKnowledgeTable(
	ctx: IExecuteFunctions,
	i: number,
	text: string,
	limit: number,
	kb: string,
	includeContent: boolean,
): Promise<IDataObject[]> {
	const kbFilter = kb ? `^kb_knowledge_baseIN${kb.replace(/\s/g, '')}` : '';
	const query = `workflow_state=published^active=true${kbFilter}^123TEXTQUERY321${text}`;
	const response = await call(
		ctx,
		'GET',
		`/api/now/table/kb_knowledge?sysparm_query=${encodeURIComponent(query)}&sysparm_fields=sys_id,number,short_description,text&sysparm_limit=${limit}&sysparm_no_count=true`,
		undefined,
		'search knowledge articles',
		i,
	);
	const { credentials } = await serviceNowCredentials.call(ctx);
	const instanceUrl = String(credentials.instanceUrl ?? '').replace(/\/+$/, '');
	return ((response.result as IDataObject[]) ?? []).map((article) => {
		const body = typeof article.text === 'string' ? htmlToText(article.text) : '';
		const out: IDataObject = {
			id: article.sys_id,
			number: article.number,
			title: article.short_description,
			snippet: body.length > 200 ? `${body.slice(0, 200)}…` : body,
			score: null,
			link: `${instanceUrl}/kb_view.do?sysparm_article=${String(article.number)}`,
			source: 'table_api',
		};
		if (includeContent) out.text = body;
		return out;
	});
}

/** listSearch: catalog items by text. */
export async function searchCatalogItems(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const text = (filter ?? '').trim();
	const response = await serviceNowApiRequest.call(
		this,
		'GET',
		`${CATALOG_API}/items?sysparm_limit=50${text ? `&sysparm_text=${encodeURIComponent(text)}` : ''}`,
	);
	return {
		results: ((response.result as IDataObject[]) ?? []).map((item) => ({
			name: String(item.name ?? item.sys_id),
			value: String(item.sys_id),
			description: item.short_description ? String(item.short_description) : undefined,
		})),
	};
}

/** Variables of a catalog item, including those inside variable sets. */
function flattenVariables(variables: IDataObject[]): IDataObject[] {
	return variables.flatMap((v) => [
		...(v.name ? [v] : []),
		...flattenVariables((v.children as IDataObject[]) ?? []),
	]);
}

/** loadOptions: variables of the selected catalog item (mandatory ones marked *). */
export async function getCatalogItemVariables(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const item = currentValue(this, 'catalogItem');
	if (!item) throw new NodeOperationError(this.getNode(), 'Select a catalog item first');
	const response = await serviceNowApiRequest.call(this, 'GET', `${CATALOG_API}/items/${item}`);
	const variables = flattenVariables(
		((response.result as IDataObject)?.variables as IDataObject[]) ?? [],
	);
	return variables
		.filter((v) => v.name)
		.map((v) => ({
			name: `${String(v.label ?? v.name)}${v.mandatory ? ' *' : ''} (${String(v.name)})`,
			value: String(v.name),
			description: v.type ? `Type: ${String(v.type)}` : undefined,
		}));
}

function variablesFor(ctx: IExecuteFunctions, i: number): IDataObject {
	if (ctx.getNodeParameter('variablesMode', i, 'fields') === 'json') {
		const raw = ctx.getNodeParameter('catalogVariablesJson', i, {}) as string | IDataObject;
		let value: unknown = raw;
		try {
			value = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
		} catch {
			throw new NodeOperationError(ctx.getNode(), 'Variables JSON is not valid JSON', {
				itemIndex: i,
			});
		}
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new NodeOperationError(ctx.getNode(), 'Variables JSON must be a JSON object', {
				itemIndex: i,
			});
		}
		return value as IDataObject;
	}
	const rows =
		(
			ctx.getNodeParameter('catalogVariables', i, {}) as {
				variable?: Array<{ name?: string; value?: unknown }>;
			}
		).variable ?? [];
	const variables: IDataObject = {};
	for (const row of rows) {
		const name = String(row.name ?? '').trim();
		if (name) variables[name] = row.value ?? '';
	}
	return variables;
}

async function orderItem(ctx: IExecuteFunctions, i: number): Promise<IDataObject> {
	const item = String(
		ctx.getNodeParameter('catalogItem', i, '', { extractValue: true }) ?? '',
	).trim();
	if (!item)
		throw new NodeOperationError(ctx.getNode(), 'Catalog Item is required', { itemIndex: i });
	const requestedFor = String(
		ctx.getNodeParameter('catalogOptions.requestedFor', i, '') ?? '',
	).trim();
	const body: IDataObject = {
		sysparm_quantity: String(ctx.getNodeParameter('quantity', i, 1)),
		variables: variablesFor(ctx, i),
	};
	if (requestedFor) body.sysparm_requested_for = requestedFor;

	const response = await call(
		ctx,
		'POST',
		`${CATALOG_API}/items/${item}/order_now`,
		body,
		'order the catalog item',
		i,
	);
	const order = (response.result as IDataObject) ?? {};
	const out: IDataObject = { ...order };

	if (ctx.getNodeParameter('catalogOptions.includeRequestedItems', i, true)) {
		const requestId = String(order.request_id ?? order.sys_id ?? '');
		if (requestId) {
			const ritms = await call(
				ctx,
				'GET',
				`/api/now/table/sc_req_item?sysparm_query=${encodeURIComponent(`request=${requestId}`)}&sysparm_fields=sys_id,number,state,cat_item,short_description&sysparm_display_value=true&sysparm_exclude_reference_link=true`,
				undefined,
				'read the requested items',
				i,
			);
			out.requested_items = (ritms.result as IDataObject[]) ?? [];
		}
	}
	return out;
}

/** Article HTML to plain text for agents and summaries. */
function htmlToText(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, ' ')
		.replace(/\n\s*\n+/g, '\n\n')
		.trim();
}

async function searchKnowledge(ctx: IExecuteFunctions, i: number): Promise<IDataObject[]> {
	const text = String(ctx.getNodeParameter('knowledgeQuery', i, '') ?? '').trim();
	if (!text)
		throw new NodeOperationError(ctx.getNode(), 'Search Text is required', { itemIndex: i });
	const limit = Number(ctx.getNodeParameter('knowledgeLimit', i, 5)) || 5;
	const kb = String(ctx.getNodeParameter('knowledgeOptions.knowledgeBase', i, '') ?? '').trim();
	const includeContent = ctx.getNodeParameter(
		'knowledgeOptions.includeContent',
		i,
		false,
	) as boolean;

	let response: IDataObject;
	try {
		response = await serviceNowApiRequest.call(
			ctx,
			'GET',
			`${KNOWLEDGE_API}/articles?query=${encodeURIComponent(text)}&limit=${limit}${kb ? `&kb=${encodeURIComponent(kb)}` : ''}`,
		);
	} catch (error) {
		// Without the Knowledge Management REST API plugin ServiceNow answers 400
		// ("Requested URI does not represent any resource") or 404.
		const status = statusOf(error);
		if (status === 400 || status === 404) {
			return await searchKnowledgeTable(ctx, i, text, limit, kb, includeContent);
		}
		throw new NodeApiError(ctx.getNode(), error as JsonObject, {
			message: `Could not search knowledge articles${status ? ` (HTTP ${status})` : ''}`,
			description: describeFailedRequest(ctx, 'GET', `${KNOWLEDGE_API}/articles`, undefined, error),
			itemIndex: i,
		});
	}
	const articles = (((response.result as IDataObject)?.articles as IDataObject[]) ?? []).slice(
		0,
		limit,
	);
	const results: IDataObject[] = [];
	for (const article of articles) {
		const out: IDataObject = {
			id: article.id,
			number: article.number,
			title: article.title,
			snippet: typeof article.snippet === 'string' ? htmlToText(article.snippet) : article.snippet,
			score: article.score,
			link: article.link,
		};
		if (includeContent && article.id) {
			const full = await call(
				ctx,
				'GET',
				`${KNOWLEDGE_API}/articles/${String(article.id)}`,
				undefined,
				'read the knowledge article',
				i,
			);
			const content = (full.result as IDataObject)?.content;
			out.text = typeof content === 'string' ? htmlToText(content) : null;
		}
		results.push(out);
	}
	return results;
}

/** execute() for Order Catalog Item and Search Knowledge, per item. */
export async function executeCatalogAction(
	ctx: IExecuteFunctions,
	operation: string,
): Promise<INodeExecutionData[][]> {
	const out: INodeExecutionData[] = [];
	const items = ctx.getInputData();
	for (let i = 0; i < items.length; i++) {
		const run = async () =>
			operation === 'orderCatalogItem' ? await orderItem(ctx, i) : await searchKnowledge(ctx, i);
		const push = (result: IDataObject | IDataObject[]) => {
			for (const json of Array.isArray(result) ? result : [result])
				out.push({ json, pairedItem: { item: i } });
		};
		if (!ctx.continueOnFail()) {
			push(await run());
			continue;
		}
		try {
			push(await run());
		} catch (error) {
			out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
		}
	}
	return [out];
}
