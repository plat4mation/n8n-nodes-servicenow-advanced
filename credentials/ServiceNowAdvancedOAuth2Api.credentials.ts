import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

export class ServiceNowAdvancedOAuth2Api implements ICredentialType {
	name = 'serviceNowAdvancedOAuth2Api';

	extends = ['oAuth2Api'];

	displayName = 'ServiceNow Advanced OAuth2 API';

	icon: Icon = { light: 'file:../icons/servicenow.svg', dark: 'file:../icons/servicenow.dark.svg' };

	documentationUrl =
		'https://www.servicenow.com/docs/bundle/xanadu-platform-security/page/administer/security/concept/c_OAuthApplications.html';

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
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'options',
			options: [
				{ name: 'Authorization Code', value: 'authorizationCode' },
				{ name: 'Client Credentials', value: 'clientCredentials' },
			],
			default: 'authorizationCode',
		},
		{
			displayName: 'Authorization URL',
			name: 'authUrl',
			type: 'hidden',
			default: '={{$self["instanceUrl"].replace(/\\/+$/, "")}}/oauth_auth.do',
			required: true,
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			default: '={{$self["instanceUrl"].replace(/\\/+$/, "")}}/oauth_token.do',
			required: true,
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
			default: 'useraccount',
		},
		{
			displayName: 'Auth URI Query Parameters',
			name: 'authQueryParameters',
			type: 'hidden',
			default: 'response_type=code',
		},
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'hidden',
			default: 'header',
		},
	];
}
