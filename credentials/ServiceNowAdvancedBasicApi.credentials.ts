import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class ServiceNowAdvancedBasicApi implements ICredentialType {
	name = 'serviceNowAdvancedBasicApi';

	displayName = 'ServiceNow Advanced Basic Auth API';

	icon: Icon = { light: 'file:../icons/servicenow.svg', dark: 'file:../icons/servicenow.dark.svg' };

	documentationUrl =
		'https://www.servicenow.com/docs/bundle/xanadu-api-reference/page/integrate/inbound-rest/concept/c_RESTAPI.html';

	properties: INodeProperties[] = [
		{
			displayName: 'Instance URL',
			name: 'instanceUrl',
			type: 'string',
			default: '',
			placeholder: 'e.g. https://dev12345.service-now.com',
			description: 'Base URL of the ServiceNow instance, without a trailing slash',
			required: true,
		},
		{
			displayName: 'n8n Base URL',
			name: 'n8nBaseUrl',
			type: 'string',
			default: '',
			placeholder: 'e.g. https://gateway.example.com/n8n',
			description:
				'Public base URL ServiceNow uses to call this n8n (e.g. an API gateway route), without a trailing slash. Leave empty to use the n8n webhook URL.',
		},
		{
			displayName: 'HITL Requester System',
			name: 'requesterSystem',
			type: 'string',
			default: '',
			placeholder: 'e.g. n8n_dev',
			description:
				'Code of the active x_pl4_hitl_tool record for this n8n environment. Required by the approval, question and error nodes.',
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			required: true,
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			auth: {
				username: '={{$credentials.username}}',
				password: '={{$credentials.password}}',
			},
		},
	};

	// Lists the n8n interfaces: proves the login works and the user has the
	// x_pl4_n8n.api role the trigger needs. (A credential test can make one
	// request only; a missing HITL role is explained when a HITL request fails.)
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.instanceUrl.replace(/\\/+$/, "")}}',
			url: '/api/x_pl4_n8n/v1/interface',
			qs: { active: 'true' },
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 403,
					message:
						'Logged in, but the user lacks the x_pl4_n8n.api role needed for the ServiceNow Advanced Trigger',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 404,
					message: 'The x_pl4_n8n app is not installed on this instance (interface API not found)',
				},
			},
		],
	};
}
