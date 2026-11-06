import {
	NodeApiError,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type IWebhookFunctions,
	type IWebhookResponseData,
	type JsonObject,
} from 'n8n-workflow';
import { resumeUrlFor } from './hitl';
import {
	describeFailedRequest,
	INTERFACE_API,
	serviceNowApiRequest,
	serviceNowCredentials,
	statusOf,
	urlOrigin,
	urlPath,
} from './transport';
import { conditionFromParameters } from './watchFields';

/**
 * Wait for Record: pause the execution until a record on a watch table is
 * inserted/updated and matches a condition. Built on the interface API: a
 * temporary watch_trigger interface whose path is this execution's resume URL.
 * The first matching save resumes the run; the webhook then deletes the
 * interface. ServiceNow only fires on saves, so a record that already matches
 * is found with a Table API query first.
 *
 * On timeout n8n gives the node no chance to clean up, so the identifier
 * carries its deadline (`n8n_wait_<execution>_<node>_<epoch>`) and every new
 * registration first deletes temporary interfaces past their deadline.
 */

const IDENTIFIER_PREFIX = 'n8n_wait_';
const IDENTIFIER = /^n8n_wait_[a-z0-9]+_[a-z0-9]+_(\d{10})$/;
export const CHANGE_OPERATORS = /VALCHANGES|CHANGESFROM|CHANGESTO/;

/** Outputs of a waiting Wait for Record step. */
const MATCHED = 0;
const TIMED_OUT = 1;

/** Restrict every OR block (^NQ) of the condition to one record. */
export function scopeToRecord(condition: string, sysId: string): string {
	if (!sysId) return condition;
	if (!condition) return `sys_id=${sysId}`;
	return condition
		.split('^NQ')
		.map((block) => `sys_id=${sysId}^${block}`)
		.join('^NQ');
}

function waitIdentifier(ctx: IExecuteFunctions, deadline: Date): string {
	const execution = String(ctx.getExecutionId())
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '');
	const node = String(ctx.getNode().id)
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '')
		.slice(0, 12);
	return `${IDENTIFIER_PREFIX}${execution}_${node}_${Math.floor(deadline.getTime() / 1000)}`;
}

/** Delete temporary wait interfaces whose deadline has passed (left by timed-out waits). */
async function deleteExpiredWaits(ctx: IExecuteFunctions): Promise<void> {
	try {
		const response = await serviceNowApiRequest.call(ctx, 'GET', `${INTERFACE_API}/interface`);
		const records = ((response.result as IDataObject)?.records as IDataObject[]) ?? [];
		const now = Date.now() / 1000;
		for (const record of records) {
			const match = IDENTIFIER.exec(String(record.identifier ?? ''));
			if (!match || Number(match[1]) > now) continue;
			await serviceNowApiRequest
				.call(ctx, 'DELETE', `${INTERFACE_API}/interface/${String(record.identifier)}`)
				.catch(() => undefined);
		}
	} catch (error) {
		// Housekeeping only: never block the wait itself.
		ctx.logger.warn(
			`Wait for Record: could not clean up expired waits: ${(error as Error).message}`,
		);
	}
}

/** The first record that already matches, or undefined. */
async function findMatching(
	ctx: IExecuteFunctions,
	table: string,
	condition: string,
): Promise<IDataObject | undefined> {
	const query = [
		`sysparm_query=${encodeURIComponent(condition)}`,
		'sysparm_limit=1',
		'sysparm_exclude_reference_link=true',
	].join('&');
	try {
		const response = await serviceNowApiRequest.call(
			ctx,
			'GET',
			`/api/now/table/${encodeURIComponent(table)}?${query}`,
		);
		return ((response.result as IDataObject[]) ?? [])[0];
	} catch (error) {
		throw new NodeApiError(ctx.getNode(), error as JsonObject, {
			message: `Could not check ${table} for a record that already matches`,
			description: describeFailedRequest(ctx, 'GET', `/api/now/table/${table}`, undefined, error),
		});
	}
}

function routed(index: number, json: IDataObject): INodeExecutionData[][] {
	const outputs: INodeExecutionData[][] = [[], []];
	outputs[index].push({ json, pairedItem: { item: 0 } });
	return outputs;
}

/** execute() for the Wait for Record operation. Only the first input item is used. */
export async function executeWaitForRecord(
	ctx: IExecuteFunctions,
): Promise<INodeExecutionData[][]> {
	if (ctx.isToolExecution()) {
		throw new NodeOperationError(ctx.getNode(), 'Wait for Record cannot run as an AI agent tool', {
			description: 'A tool call cannot pause. Use it as a workflow step instead.',
		});
	}

	const get = (name: string, fallback: unknown) => ctx.getNodeParameter(name, 0, fallback);
	const table = String(
		ctx.getNodeParameter('watchTable', 0, '', { extractValue: true }) ?? '',
	).trim();
	if (!table) throw new NodeOperationError(ctx.getNode(), 'Table is required');
	const sysId = String(get('recordSysId', '') ?? '').trim();
	const condition = scopeToRecord(conditionFromParameters(get), sysId);
	const operation = get('watchOperation', 'update') as string;
	const maxWaitHours = Number(get('waitOptions.maxWaitHours', 24)) || 24;
	const checkFirst = get('waitOptions.checkExisting', true) as boolean;

	// ServiceNow only fires on a save; a record that already matches never would.
	if (checkFirst && !CHANGE_OPERATORS.test(condition)) {
		const existing = await findMatching(ctx, table, condition);
		if (existing) {
			return routed(MATCHED, {
				matched: true,
				table,
				sys_id: existing.sys_id ?? null,
				operation: 'already_matching',
				record: existing,
			});
		}
	}

	await deleteExpiredWaits(ctx);

	const deadline = new Date(Date.now() + maxWaitHours * 60 * 60 * 1000);
	const identifier = waitIdentifier(ctx, deadline);
	const resumeUrl = resumeUrlFor(ctx);
	const { credentials } = await serviceNowCredentials.call(ctx);
	const baseUrl =
		((credentials.n8nBaseUrl as string | undefined) ?? '').trim().replace(/\/+$/, '') ||
		urlOrigin(resumeUrl);
	const workflow = ctx.getWorkflow();
	const registration: IDataObject = {
		identifier,
		name: `Wait for ${table}: ${workflow.name ?? workflow.id}`.slice(0, 100),
		type: 'watch_trigger',
		path: urlPath(resumeUrl),
		base_url: baseUrl,
		expected_payload: null,
		watch_table: table,
		watch_operation: operation,
		watch_condition: condition || null,
	};
	try {
		await serviceNowApiRequest.call(ctx, 'POST', `${INTERFACE_API}/interface`, registration);
	} catch (error) {
		const status = statusOf(error);
		throw new NodeApiError(ctx.getNode(), error as JsonObject, {
			message: `Could not start waiting for ${table}${status ? ` (HTTP ${status})` : ''}`,
			description: describeFailedRequest(
				ctx,
				'POST',
				`${INTERFACE_API}/interface`,
				registration,
				error,
			),
		});
	}

	await ctx.putExecutionToWait(deadline);

	// Becomes the output only when the wait times out; a matching save replaces it.
	return routed(TIMED_OUT, { matched: false, outcome: 'timed_out', table, identifier });
}

/** webhook() for Wait for Record: resume with the record and remove the temporary interface. */
export async function waitForRecordWebhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
	const body = this.getBodyData() as IDataObject;
	const data = (body?.data ?? body) as IDataObject;
	if (!data || typeof data !== 'object' || !data.table || !data.sys_id) {
		this.getResponseObject()
			.status(400)
			.json({ error: 'Expected a record change with table and sys_id' });
		return { noWebhookResponse: true };
	}

	// The envelope's message_type is the interface identifier.
	const identifier = String(body.message_type ?? '');
	if (identifier.startsWith(IDENTIFIER_PREFIX)) {
		await serviceNowApiRequest
			.call(this, 'DELETE', `${INTERFACE_API}/interface/${identifier}`)
			.catch((error: Error) =>
				this.logger.warn(`Wait for Record: could not remove ${identifier}: ${error.message}`),
			);
	}

	return {
		workflowData: [
			[
				{
					json: {
						matched: true,
						table: data.table,
						sys_id: data.sys_id,
						operation: data.operation ?? null,
						record: data.record ?? null,
					},
				},
			],
			[],
		],
	};
}
