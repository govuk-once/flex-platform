import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { assert, describe, expect, it } from "vitest";

import { ACCOUNT, EDGE_ROLE, stackIn } from "../test/helpers.ts";
import { ProxyApi } from "./proxy-api.ts";

function build(nag = false) {
  const stack = stackIn("eu-west-2", nag);
  const proxyApi = new ProxyApi(stack, "Domain", {
    environment: "sandbox",
    domain: "domain-a",
    edgeRole: EDGE_ROLE,
  });
  const app = stack.node.root;
  assert.instanceOf(app, App);
  return {
    app,
    proxyApi,
    stack,
  };
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
      const { stack } = build();
      const template = Template.fromStack(stack);

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
      Template.fromStack(build().stack).hasResourceProperties(
        "AWS::ApiGateway::RestApi",
        {
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
        },
      );
    });

    it("creates no logging role or account setting of its own", () => {
      Template.fromStack(build().stack).resourceCountIs(
        "AWS::ApiGateway::Account",
        0,
      );
    });
  });

  describe("the routes", () => {
    it("pass every method on the root and every path below it to the function's live alias, with IAM authorisation", () => {
      const { stack } = build();
      const template = Template.fromStack(stack);

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

    // Exact, so a condition can't come back: API Gateway sends no `aws:SourceAccount` when it
    // assumes the role, and one that names it refuses every request.
    it("invoke through a role API Gateway assumes, under no condition, which may invoke only this domain's live alias", () => {
      const { stack } = build();
      const template = Template.fromStack(stack);

      template.resourceCountIs("AWS::IAM::Role", 1);
      template.hasResourceProperties("AWS::IAM::Role", {
        AssumeRolePolicyDocument: Match.exact({
          Statement: [
            {
              Action: "sts:AssumeRole",
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
      const { stack } = build();
      const template = Template.fromStack(stack);

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
      Template.fromStack(build().stack).hasResourceProperties(
        "AWS::ApiGateway::Stage",
        {
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
        },
      );
    });

    it("writes JSON access logs, with the X-Ray trace ID, to the domain's own log group", () => {
      const { stack } = build();
      const template = Template.fromStack(stack);

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

    it("creates its execution log group before the stage, so API Gateway never does", () => {
      const { stack } = build();
      const template = Template.fromStack(stack);
      const groups = Object.keys(
        template.findResources("AWS::Logs::LogGroup", {
          Properties: {
            LogGroupName: {
              "Fn::Join": [
                "",
                ["API-Gateway-Execution-Logs_", API, "/default"],
              ],
            },
          },
        }),
      );
      expect(groups).toHaveLength(1);

      template.hasResource("AWS::ApiGateway::Stage", {
        DependsOn: Match.arrayWith(groups),
      });
    });
  });

  describe("its refusals", () => {
    const NAMESPACE = "flex/domain/sandbox/domain-a/api";

    it.each([
      [
        "bypass-attempts",
        '{ ($.errorResponseType = "MISSING_AUTHENTICATION_TOKEN") || ($.errorResponseType = "ACCESS_DENIED") }',
      ],
      [
        "signing-faults",
        '{ ($.errorResponseType = "INVALID_SIGNATURE") || ($.errorResponseType = "EXPIRED_TOKEN") }',
      ],
    ])(
      "count %s from the access log, in the API's own namespace",
      (name, pattern) => {
        Template.fromStack(build().stack).hasResourceProperties(
          "AWS::Logs::MetricFilter",
          {
            LogGroupName: { Ref: Match.stringLikeRegexp("^DomainAccessLogs") },
            FilterPattern: pattern,
            MetricTransformations: Match.exact([
              {
                MetricNamespace: NAMESPACE,
                MetricName: name,
                MetricValue: "1",
              },
            ]),
          },
        );
      },
    );

    it.each([
      ["bypass-attempts", 10],
      ["signing-faults", 1],
    ])(
      "alarm on sustained %s, with no action until alerting exists",
      (name, threshold) => {
        Template.fromStack(build().stack).hasResourceProperties(
          "AWS::CloudWatch::Alarm",
          {
            AlarmName: `domain-sandbox-domain-a-api-${name}`,
            AlarmDescription: Match.stringLikeRegexp(
              "Investigating an origin refusal alarm",
            ),
            Namespace: NAMESPACE,
            MetricName: name,
            Dimensions: Match.absent(),
            Statistic: "Sum",
            Period: 300,
            Threshold: threshold,
            EvaluationPeriods: 3,
            DatapointsToAlarm: Match.absent(),
            ComparisonOperator: "GreaterThanOrEqualToThreshold",
            TreatMissingData: "notBreaching",
            AlarmActions: Match.absent(),
            OKActions: Match.absent(),
            InsufficientDataActions: Match.absent(),
          },
        );
      },
    );

    it("exposes each alarm by its kind of refusal", () => {
      const { proxyApi } = build();

      expect(
        Object.fromEntries(
          Object.entries(proxyApi.alarms).map(([kind, alarm]) => [
            kind,
            alarm.node.id,
          ]),
        ),
      ).toEqual({
        bypassAttempts: "BypassAttempts",
        signingFaults: "SigningFaults",
      });
    });

    it("has no other metric filter or alarm", () => {
      const { stack } = build();
      const template = Template.fromStack(stack);

      template.resourceCountIs("AWS::Logs::MetricFilter", 2);
      template.resourceCountIs("AWS::CloudWatch::Alarm", 2);
    });
  });

  it("answers its own refusals in the Frontdoor's shape, saying API Gateway refused", () => {
    const { stack } = build();
    const template = Template.fromStack(stack);

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
