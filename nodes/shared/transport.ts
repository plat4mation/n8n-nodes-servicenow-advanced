import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	INodeProperties,
	IWebhookFunctions,
} from 'n8n-workflow';

/**
 * The Authentication selector. Nodes list both credentials in their description,
 * each shown via `displayOptions: { show: { authentication: [...] } }`.
 */
export const authenticationProperty: INodeProperties = {
	displayName: 'Authentication',
	name: 'authentication',
	type: 'options',
	options: [
		{ name: 'OAuth2', value: 'oAuth2' },
		{ name: 'Basic Auth', value: 'basicAuth' },
	],
	default: 'oAuth2',
};

/** Per-request time limit, so a ServiceNow that stops responding can't hang a step forever. */
const REQUEST_TIMEOUT_MS = 120_000;

/** Base paths of the x_pl4_n8n and x_pl4_hitl Scripted REST APIs. */
export const INTERFACE_API = '/api/x_pl4_n8n/v1';
export const HITL_API = '/api/x_pl4_hitl/v1';

export type ServiceNowContext =
	| IHookFunctions
	| IExecuteFunctions
	| ILoadOptionsFunctions
	| IWebhookFunctions;

/** The credential selected by the node's Authentication option, and its type name. */
export async function serviceNowCredentials(
	this: ServiceNowContext,
): Promise<{ credentialName: string; credentials: IDataObject }> {
	// Only execute() takes an item index; hook/webhook/loadOptions contexts don't.
	const authentication = (
		'getInputData' in this
			? this.getNodeParameter('authentication', 0, 'oAuth2')
			: (this as IHookFunctions).getNodeParameter('authentication', 'oAuth2')
	) as string;
	const credentialName =
		authentication === 'basicAuth' ? 'serviceNowAdvancedBasicApi' : 'serviceNowAdvancedOAuth2Api';
	return { credentialName, credentials: await this.getCredentials(credentialName) };
}

/** Call a ServiceNow REST path (e.g. `${INTERFACE_API}/interface`) on the instance in the credential. */
export async function serviceNowApiRequest(
	this: ServiceNowContext,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
): Promise<IDataObject> {
	const { credentialName, credentials } = await serviceNowCredentials.call(this);
	const instanceUrl = (credentials.instanceUrl as string).replace(/\/+$/, '');

	const url = `${instanceUrl}${path}`;
	this.logger.debug(`ServiceNow request: ${method} ${url}`, { body });

	return (await this.helpers.httpRequestWithAuthentication.call(this, credentialName, {
		method,
		url,
		body,
		json: true,
		timeout: REQUEST_TIMEOUT_MS,
	})) as IDataObject;
}

/** Upload a file to a record with the standard Attachment API. */
export async function serviceNowUploadAttachment(
	this: IExecuteFunctions,
	table: string,
	sysId: string,
	fileName: string,
	mimeType: string,
	data: Buffer,
): Promise<IDataObject> {
	const { credentialName, credentials } = await serviceNowCredentials.call(this);
	const instanceUrl = (credentials.instanceUrl as string).replace(/\/+$/, '');
	const qs = `table_name=${encodeURIComponent(table)}&table_sys_id=${encodeURIComponent(sysId)}&file_name=${encodeURIComponent(fileName)}`;
	const response = (await this.helpers.httpRequestWithAuthentication.call(this, credentialName, {
		method: 'POST',
		url: `${instanceUrl}/api/now/attachment/file?${qs}`,
		headers: { 'Content-Type': mimeType || 'application/octet-stream', Accept: 'application/json' },
		body: data,
		json: false,
		timeout: REQUEST_TIMEOUT_MS,
	})) as string | IDataObject;
	const parsed = typeof response === 'string' ? (JSON.parse(response) as IDataObject) : response;
	return (parsed.result as IDataObject) ?? {};
}

/** Download an attachment's file content with the standard Attachment API. */
export async function serviceNowDownloadAttachment(
	this: IExecuteFunctions,
	attachmentSysId: string,
): Promise<Buffer> {
	const { credentialName, credentials } = await serviceNowCredentials.call(this);
	const instanceUrl = (credentials.instanceUrl as string).replace(/\/+$/, '');
	const data = (await this.helpers.httpRequestWithAuthentication.call(this, credentialName, {
		method: 'GET',
		url: `${instanceUrl}/api/now/attachment/${encodeURIComponent(attachmentSysId)}/file`,
		headers: { Accept: '*/*' },
		encoding: 'arraybuffer',
		json: false,
		timeout: REQUEST_TIMEOUT_MS,
	})) as ArrayBuffer | Buffer;
	return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

/**
 * Error description for a failed ServiceNow call: ServiceNow's own error text
 * plus the exact request body (to replay in REST API Explorer). Also logs it
 * at warn level, so it shows in the n8n console without debug logging.
 */
export function describeFailedRequest(
	ctx: ServiceNowContext,
	method: IHttpRequestMethods,
	path: string,
	body: IDataObject | undefined,
	error: unknown,
): string {
	const status = statusOf(error);
	const detail = serviceNowErrorDetail(error);
	const payload = body === undefined ? '(none)' : redactSignature(JSON.stringify(body, null, 2));
	const roleHint =
		status === 403
			? path.startsWith(HITL_API)
				? 'The ServiceNow user needs the x_pl4_hitl.api and snc_internal roles.'
				: path.startsWith(INTERFACE_API)
					? 'The ServiceNow user needs the x_pl4_n8n.api role.'
					: undefined
			: undefined;
	ctx.logger.warn(
		`ServiceNow ${method} ${path} failed${status ? ` (HTTP ${status})` : ''}: ${detail ?? (error as Error).message}\nRequest body:\n${payload}`,
	);
	return [roleHint, detail, `Request body: ${redactSignature(JSON.stringify(body ?? null))}`]
		.filter(Boolean)
		.join('\n\n');
}

/**
 * Hide the `signature` query value of resume URLs. Whoever has it can post a
 * decision to the waiting execution, so it must not end up in logs or errors.
 */
export function redactSignature(text: string): string {
	return text.replace(/([?&]signature=)[^&"\s]+/g, '$1***');
}

/** Best-effort HTTP status extraction from an httpRequest error. */
export function statusOf(error: unknown): number | undefined {
	const e = error as {
		httpCode?: string | number;
		statusCode?: number;
		response?: { statusCode?: number; status?: number };
	};
	const raw = e?.httpCode ?? e?.statusCode ?? e?.response?.statusCode ?? e?.response?.status;
	const num = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
	return typeof num === 'number' && Number.isFinite(num) ? num : undefined;
}

/**
 * Readable one-liner from a non-JSON error body. ServiceNow answers with an
 * HTML page (with inline CSS) when the whole instance is unavailable, e.g. a
 * hibernating developer instance ("Service Interruption").
 */
function plainText(body: string): string {
	if (!/<[a-z!]/i.test(body)) return body.trim().slice(0, 500);
	const text = body
		.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/\s+/g, ' ')
		.trim();
	return text.slice(0, 300);
}

/**
 * ServiceNow's own error text from a failed request. n8n's generic message
 * ("Bad request - please check your parameters") hides it. Handles both the
 * x_pl4_n8n script envelope `{result:{error:{code,message,details[]}}}` and the
 * platform envelope `{error:{message,detail}}` (401/403 before the script runs).
 */
export function serviceNowErrorDetail(error: unknown): string | undefined {
	// httpRequestWithAuthentication throws a NodeApiError that keeps the parsed
	// body in context.data and the original AxiosError as cause.
	const e = error as {
		context?: { data?: unknown };
		response?: { data?: unknown };
		cause?: { response?: { data?: unknown } };
	};
	let data = e?.context?.data ?? e?.cause?.response?.data ?? e?.response?.data;
	if (typeof data === 'string') {
		try {
			data = JSON.parse(data);
		} catch {
			return plainText(data as string) || undefined;
		}
	}
	if (!data || typeof data !== 'object') return undefined;

	const body = data as IDataObject;
	const err = (((body.result as IDataObject)?.error ?? body.error) as IDataObject) ?? undefined;
	if (!err) return JSON.stringify(body);

	const head = [err.code, err.message].filter((p) => typeof p === 'string' && p).join(': ');
	// 5xx errors carry a system log reference for the ServiceNow administrator.
	const reference = typeof err.reference === 'string' ? `log reference ${err.reference}` : '';
	const fields = Array.isArray(err.details)
		? (err.details as IDataObject[]).map((d) => `${d.field}: ${d.message}`)
		: [];
	if (typeof err.detail === 'string' && err.detail) fields.push(err.detail);
	return [head, ...fields, reference].filter(Boolean).join(' | ') || JSON.stringify(body);
}

/** Origin (scheme + host + port) of a URL. */
export function urlOrigin(url: string): string {
	return url.match(/^https?:\/\/[^/]+/i)?.[0] ?? '';
}

/** Strip scheme and host so ServiceNow only gets the path (+ query) of an n8n URL. */
export function urlPath(url: string): string {
	return url.replace(/^https?:\/\/[^/]+/i, '') || '/';
}
