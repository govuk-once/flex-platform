import { PlatformLogGroup } from "@repo/infra-constructs";
import { ArnFormat, Stack, Validations } from "aws-cdk-lib";
import {
  AccessLogField,
  AccessLogFormat,
  AuthorizationType,
  EndpointType,
  Integration,
  IntegrationType,
  LogGroupLogDestination,
  MethodLoggingLevel,
  ResponseType,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import {
  AccountPrincipal,
  AnyPrincipal,
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

import {
  apiAccessLogGroupName,
  apiExecutionLogGroupName,
  apiName,
  domainFunctionName,
  LIVE_ALIAS,
} from "./names.ts";

const STAGE_NAME = "default";

const AUTH_ERROR = { message: "Unauthorized", type: "auth_error" };
const TOO_MANY_REQUESTS = {
  message: "Too many requests",
  type: "client_error",
};
const SERVER_ERROR = { message: "Internal server error", type: "server_error" };

// API Gateway's own message for any other refusal, already a quoted JSON string. Its messages are
// fixed, so no caller's text reaches the body.
const CLIENT_ERROR =
  '{"message":$context.error.messageString,"type":"client_error"}';

const GATEWAY_RESPONSES = [
  [ResponseType.UNAUTHORIZED, JSON.stringify(AUTH_ERROR)],
  [ResponseType.ACCESS_DENIED, JSON.stringify(AUTH_ERROR)],
  [ResponseType.INVALID_SIGNATURE, JSON.stringify(AUTH_ERROR)],
  [ResponseType.MISSING_AUTHENTICATION_TOKEN, JSON.stringify(AUTH_ERROR)],
  [ResponseType.EXPIRED_TOKEN, JSON.stringify(AUTH_ERROR)],
  [ResponseType.THROTTLED, JSON.stringify(TOO_MANY_REQUESTS)],
  [ResponseType.DEFAULT_4XX, CLIENT_ERROR],
  [ResponseType.DEFAULT_5XX, JSON.stringify(SERVER_ERROR)],
] as const;

export interface ProxyApiProps {
  readonly environment: string;
  readonly domain: string;
  readonly edgeRole: {
    readonly account: string;
    readonly name: string;
  };
}

/**
 * One domain's API: every path and method, passed to the `live` alias of a function created
 * outside CloudFormation. The domain's own code routes each request.
 */
export class ProxyApi extends Construct {
  public readonly api: RestApi;

  constructor(
    scope: Construct,
    id: string,
    { environment, domain, edgeRole }: ProxyApiProps,
  ) {
    super(scope, id);

    const stack = Stack.of(this);

    // Named as a condition, never as the principal: API Gateway refuses a policy naming a role that
    // doesn't exist yet.
    const edgeRoleArn = stack.formatArn({
      service: "iam",
      region: "",
      account: edgeRole.account,
      resource: "role",
      resourceName: edgeRole.name,
    });

    const accessLogs = new PlatformLogGroup(this, "AccessLogs", {
      logGroupName: apiAccessLogGroupName(environment, domain),
    });

    const api = new RestApi(this, "Api", {
      restApiName: apiName(environment, domain),
      disableExecuteApiEndpoint: true,
      endpointConfiguration: {
        types: [EndpointType.REGIONAL],
      },
      defaultMethodOptions: {
        authorizationType: AuthorizationType.IAM,
      },
      policy: new PolicyDocument({
        statements: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            principals: [new AccountPrincipal(edgeRole.account)],
            actions: ["execute-api:Invoke"],
            resources: ["execute-api:/*"],
            conditions: {
              ArnEquals: { "aws:PrincipalArn": edgeRoleArn },
            },
          }),
          new PolicyStatement({
            effect: Effect.DENY,
            principals: [new AnyPrincipal()],
            actions: ["execute-api:Invoke"],
            resources: ["execute-api:/*"],
            conditions: {
              ArnNotEquals: { "aws:PrincipalArn": edgeRoleArn },
            },
          }),
        ],
      }),
      deployOptions: {
        stageName: STAGE_NAME,
        loggingLevel: MethodLoggingLevel.ERROR,
        accessLogDestination: new LogGroupLogDestination(accessLogs.logGroup),
        accessLogFormat: AccessLogFormat.custom(
          JSON.stringify({
            requestId: AccessLogField.contextRequestId(),
            xrayTraceId: AccessLogField.contextXrayTraceId(),
            requestTime: AccessLogField.contextRequestTime(),
            httpMethod: AccessLogField.contextHttpMethod(),
            resourcePath: AccessLogField.contextResourcePath(),
            status: AccessLogField.contextStatus(),
            responseLength: AccessLogField.contextResponseLength(),
            responseLatency: AccessLogField.contextResponseLatency(),
            integrationLatency: AccessLogField.contextIntegrationLatency(),
            errorResponseType: AccessLogField.contextErrorResponseType(),
          }),
        ),
        tracingEnabled: true,
      },
    });

    // CDK always outputs the execute-api URL, even with that endpoint off, which would publish a URL
    // that never answers.
    api.node.tryRemoveChild("Endpoint");

    new PlatformLogGroup(this, "ExecutionLogs", {
      logGroupName: apiExecutionLogGroupName(api.restApiId, STAGE_NAME),
    });

    Validations.of(api).acknowledge(
      {
        id: "AwsSolutions-APIG2",
        reason:
          "Every request goes to the domain's own code, which validates it. The API has no request models to check against.",
      },
      {
        id: "AwsSolutions-APIG3",
        reason:
          "WAF runs at the Frontdoor. The resource policy and IAM authorisation refuse anything the Frontdoor's edge role didn't sign.",
      },
      {
        id: "AwsSolutions-COG4",
        reason:
          "The Frontdoor verifies the caller's Cognito token, then signs the request with SigV4, which IAM authorisation checks.",
      },
    );

    this.addRoutes(api, { stack, environment, domain });
    this.addGatewayResponses(api);

    this.api = api;
  }

  // The function isn't in any template, so the integration names its `live` alias by ARN and
  // invokes it through a role of the API's own. No permission on the function is needed.
  private addRoutes(
    api: RestApi,
    {
      stack,
      environment,
      domain,
    }: { stack: Stack; environment: string; domain: string },
  ): void {
    const liveFunction = stack.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: `${domainFunctionName(environment, domain)}:${LIVE_ALIAS}`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    const role = new Role(this, "IntegrationRole", {
      assumedBy: new ServicePrincipal("apigateway.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": stack.account },
        },
      }),
      inlinePolicies: {
        Invoke: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["lambda:InvokeFunction"],
              resources: [liveFunction],
            }),
          ],
        }),
      },
    });

    const integration = new Integration({
      type: IntegrationType.AWS_PROXY,
      integrationHttpMethod: "POST",
      uri: `arn:${stack.partition}:apigateway:${stack.region}:lambda:path/2015-03-31/functions/${liveFunction}/invocations`,
      options: { credentialsRole: role },
    });

    api.root.addMethod("ANY", integration);
    api.root.addProxy({ defaultIntegration: integration, anyMethod: true });
  }

  private addGatewayResponses(api: RestApi): void {
    for (const [type, body] of GATEWAY_RESPONSES) {
      api.addGatewayResponse(type.responseType, {
        type,
        // As the Frontdoor's own refusals say which part refused.
        responseHeaders: { "x-rejected-by": "'api-gateway'" },
        templates: { "application/json": body },
      });
    }
  }
}
