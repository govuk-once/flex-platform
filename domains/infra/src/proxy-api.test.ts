import type { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ACCOUNT, EDGE_ROLE, stackIn } from "../test/helpers.ts";
import { ProxyApi } from "./proxy-api.ts";

function build(nag = false) {
  const stack = stackIn("eu-west-2", nag);
  new ProxyApi(stack, "Domain", {
    environment: "sandbox",
    domain: "domain-a",
    edgeRole: EDGE_ROLE,
  });
  return { app: stack.node.root as App, template: Template.fromStack(stack) };
}

const EDGE_ROLE_ARN = `arn:aws:iam::${EDGE_ROLE.account}:role/${EDGE_ROLE.name}`;

const LIVE_FUNCTION = `arn:aws:lambda:eu-west-2:${ACCOUNT}:function:domain-sandbox-domain-a:live`;

const API = { Ref: Match.stringLikeRegexp("^DomainApi") };

describe("ProxyApi", () => {
  it("has no unacknowledged cdk-nag finding", () => {
    expect(() => build(true).app.synth()).not.toThrow();
  });

  describe("the API", () => {
    it("is one regional API, reachable only through a custom domain, publishing no URL", () => {
      const { template } = build();

      template.resourceCountIs("AWS::ApiGateway::RestApi", 1);
      template.hasResourceProperties("AWS::ApiGateway::RestApi", {
        Name: "domain-sandbox-domain-a-api",
        EndpointConfiguration: { Types: ["REGIONAL"] },
        DisableExecuteApiEndpoint: true,
      });
      const { Outputs } = template.toJSON() as {
        Outputs?: Record<string, unknown>;
      };

      expect(Object.keys(Outputs ?? {})).toEqual([]);
    });

    it("lets in only the Frontdoor's edge role, and denies everyone else", () => {
      build().template.hasResourceProperties("AWS::ApiGateway::RestApi", {
        Policy: Match.exact({
          Statement: [
            {
              Action: "execute-api:Invoke",
              Effect: "Allow",
              Principal: { AWS: `arn:aws:iam::${EDGE_ROLE.account}:root` },
              Resource: "execute-api:/*",
              Condition: { ArnEquals: { "aws:PrincipalArn": EDGE_ROLE_ARN } },
            },
            {
              Action: "execute-api:Invoke",
              Effect: "Deny",
              Principal: { AWS: "*" },
              Resource: "execute-api:/*",
              Condition: {
                ArnNotEquals: { "aws:PrincipalArn": EDGE_ROLE_ARN },
              },
            },
          ],
          Version: "2012-10-17",
        }),
      });
    });

    it("creates no logging role or account setting of its own", () => {
      build().template.resourceCountIs("AWS::ApiGateway::Account", 0);
    });
  });

  describe("the routes", () => {
    it("pass every method on the root and every path below it to the function's live alias, with IAM authorisation", () => {
      const { template } = build();

      const methods = Object.values(
        template.findResources("AWS::ApiGateway::Method"),
      ).map(({ Properties }) => Properties as Record<string, unknown>);

      expect(methods).toHaveLength(2);
      for (const method of methods) {
        expect(method).toMatchObject({
          HttpMethod: "ANY",
          AuthorizationType: "AWS_IAM",
          Integration: {
            Type: "AWS_PROXY",
            IntegrationHttpMethod: "POST",
            Uri: `arn:aws:apigateway:eu-west-2:lambda:path/2015-03-31/functions/${LIVE_FUNCTION}/invocations`,
            Credentials: {
              "Fn::GetAtt": [
                expect.stringMatching(/^DomainIntegrationRole/),
                "Arn",
              ],
            },
          },
        });
      }
      template.resourceCountIs("AWS::ApiGateway::Resource", 1);
      template.hasResourceProperties("AWS::ApiGateway::Resource", {
        PathPart: "{proxy+}",
      });
    });

    it("invoke through a role API Gateway in this account assumes, which may invoke only this domain's live alias", () => {
      const { template } = build();

      template.resourceCountIs("AWS::IAM::Role", 1);
      template.hasResourceProperties("AWS::IAM::Role", {
        AssumeRolePolicyDocument: Match.exact({
          Statement: [
            {
              Action: "sts:AssumeRole",
              Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT } },
              Effect: "Allow",
              Principal: { Service: "apigateway.amazonaws.com" },
            },
          ],
          Version: "2012-10-17",
        }),
        Policies: Match.exact([
          {
            PolicyName: "Invoke",
            PolicyDocument: {
              Statement: [
                {
                  Action: "lambda:InvokeFunction",
                  Effect: "Allow",
                  Resource: LIVE_FUNCTION,
                },
              ],
              Version: "2012-10-17",
            },
          },
        ]),
      });
    });

    it("add nothing to the function, and no WAF", () => {
      const { template } = build();

      for (const type of [
        "AWS::Lambda::Function",
        "AWS::Lambda::Alias",
        "AWS::Lambda::Version",
        "AWS::Lambda::Permission",
        "AWS::WAFv2::WebACL",
        "AWS::WAFv2::WebACLAssociation",
      ]) {
        template.resourceCountIs(type, 0);
      }
    });
  });

  describe("the stage", () => {
    it("is named default, traced, and logs errors without request or response bodies", () => {
      build().template.hasResourceProperties("AWS::ApiGateway::Stage", {
        StageName: "default",
        TracingEnabled: true,
        // CDK's default turns data tracing off, which keeps bodies out of the execution logs.
        MethodSettings: Match.exact([
          {
            HttpMethod: "*",
            ResourcePath: "/*",
            LoggingLevel: "ERROR",
            DataTraceEnabled: false,
          },
        ]),
      });
    });

    it("writes JSON access logs, with the X-Ray trace ID, to the domain's own log group", () => {
      const { template } = build();

      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: "/flex/domain/sandbox/domain-a/api-access",
      });

      const [stage] = Object.values(
        template.findResources("AWS::ApiGateway::Stage"),
      );
      const { AccessLogSetting: setting } = stage?.Properties as {
        AccessLogSetting: { DestinationArn: unknown; Format: string };
      };

      expect(setting.DestinationArn).toEqual({
        "Fn::GetAtt": [expect.stringMatching(/^DomainAccessLogs/), "Arn"],
      });
      expect(JSON.parse(setting.Format)).toEqual({
        requestId: "$context.requestId",
        xrayTraceId: "$context.xrayTraceId",
        requestTime: "$context.requestTime",
        httpMethod: "$context.httpMethod",
        resourcePath: "$context.resourcePath",
        status: "$context.status",
        responseLength: "$context.responseLength",
        responseLatency: "$context.responseLatency",
        integrationLatency: "$context.integrationLatency",
        errorResponseType: "$context.error.responseType",
      });
    });

    it("creates its execution log group, which API Gateway may not", () => {
      build().template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: {
          "Fn::Join": ["", ["API-Gateway-Execution-Logs_", API, "/default"]],
        },
      });
    });
  });

  it("answers its own refusals in the Frontdoor's shape, saying API Gateway refused", () => {
    const { template } = build();

    const responses = Object.fromEntries(
      Object.values(
        template.findResources("AWS::ApiGateway::GatewayResponse"),
      ).map((response) => {
        const { ResponseType, ResponseTemplates, ResponseParameters } =
          response.Properties as {
            ResponseType: string;
            ResponseTemplates: Record<string, string>;
            ResponseParameters: Record<string, string>;
          };

        expect(ResponseParameters).toEqual({
          "gatewayresponse.header.x-rejected-by": "'api-gateway'",
        });

        return [ResponseType, ResponseTemplates["application/json"]];
      }),
    );

    const unauthorized = '{"message":"Unauthorized","type":"auth_error"}';

    expect(responses).toEqual({
      UNAUTHORIZED: unauthorized,
      ACCESS_DENIED: unauthorized,
      INVALID_SIGNATURE: unauthorized,
      MISSING_AUTHENTICATION_TOKEN: unauthorized,
      EXPIRED_TOKEN: unauthorized,
      THROTTLED: '{"message":"Too many requests","type":"client_error"}',
      DEFAULT_4XX:
        '{"message":$context.error.messageString,"type":"client_error"}',
      DEFAULT_5XX: '{"message":"Internal server error","type":"server_error"}',
    });
  });
});
