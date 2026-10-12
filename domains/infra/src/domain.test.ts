import { Validations } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";

import {
  countResourcesByType,
  createTestStack,
  DOMAIN_ACCOUNT,
  FRONTDOOR_ACCOUNT,
  FRONTDOOR_ROLE_ARN,
  HOST_NAME,
  ISOLATED_PLACEMENT,
  ISOLATED_SECURITY_GROUP_ID,
  ISOLATED_SUBNET_IDS,
  NETWORK,
  PRIVATE_SECURITY_GROUP_ID,
  PRIVATE_SUBNET_IDS,
  REGION,
  SHARED_RESOURCES,
} from "../test/helpers.ts";
import type { DomainConfig, RouteConfig } from "./config.ts";
import type { DomainProps } from "./domain.ts";
import { Domain } from "./domain.ts";

const DOMAIN_CONFIG: DomainConfig = {
  name: "domain-one",
  routes: [
    { method: "GET", path: "/a" },
    { method: "PUT", path: "/a/{id}" },
  ],
};

function synthDomainTemplate(
  config: DomainConfig = DOMAIN_CONFIG,
  overrides: Partial<Omit<DomainProps, "config">> = {},
): Template {
  const { stack } = createTestStack();

  new Domain(stack, config.name, { config, ...SHARED_RESOURCES, ...overrides });

  return Template.fromStack(stack);
}

function buildDomain(props: DomainProps): void {
  const { stack } = createTestStack();

  new Domain(stack, props.config.name, props);
}

function getLogicalIds(template: Template, type: string): string[] {
  return Object.keys(template.findResources(type)).sort();
}

function permissionSourceArn(method: string, path: string) {
  return {
    "Fn::Join": [
      "",
      [
        `arn:aws:execute-api:${REGION}:${DOMAIN_ACCOUNT}:`,
        { Ref: Match.stringLikeRegexp("^domainoneApi") },
        "/",
        { Ref: Match.stringLikeRegexp("^domainoneApiDeploymentStageprod") },
        `/${method}${path}`,
      ],
    ],
  };
}

describe("Domain", () => {
  // Acceptance test, scenario 1.
  describe("given a config declaring two routes", () => {
    const template = synthDomainTemplate();

    it("creates the API and its host mapping, the function, its role and alias, their log groups, and nothing broader", () => {
      expect(countResourcesByType(template)).toEqual({
        "AWS::ApiGateway::BasePathMapping": 1,
        "AWS::ApiGateway::Deployment": 1,
        "AWS::ApiGateway::Method": 2,
        "AWS::ApiGateway::Resource": 2,
        "AWS::ApiGateway::RestApi": 1,
        "AWS::ApiGateway::Stage": 1,
        "AWS::IAM::Role": 1,
        "AWS::KMS::Key": 1,
        "AWS::Lambda::Alias": 1,
        "AWS::Lambda::Function": 1,
        "AWS::Lambda::Permission": 2,
        "AWS::Lambda::Version": 1,
        "AWS::Logs::LogGroup": 3,
      });
    });

    it("names the function for the release pipeline", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "domain-development-domain-one",
        Runtime: "nodejs24.x",
        Architectures: ["x86_64"],
      });
    });

    it("points the live alias at the placeholder's version", () => {
      template.hasResourceProperties("AWS::Lambda::Alias", {
        Name: "live",
        FunctionVersion: {
          "Fn::GetAtt": [
            Match.stringLikeRegexp("^domainoneVersion"),
            "Version",
          ],
        },
      });
    });

    it("is a regional API with one stage", () => {
      template.hasResourceProperties("AWS::ApiGateway::RestApi", {
        Name: "domain-development-domain-one",
        EndpointConfiguration: { Types: ["REGIONAL"] },
      });

      template.hasResourceProperties("AWS::ApiGateway::Stage", {
        StageName: "prod",
      });
    });

    it.each([
      ["GET", "/a"],
      ["PUT", "/a/{id}"],
    ])("answers %s %s with IAM auth, through the alias", (method) => {
      template.hasResourceProperties("AWS::ApiGateway::Method", {
        HttpMethod: method,
        AuthorizationType: "AWS_IAM",
        Integration: {
          Type: "AWS_PROXY",
          Uri: {
            "Fn::Join": [
              "",
              Match.arrayWith([
                { Ref: Match.stringLikeRegexp("^domainoneAlias") },
              ]),
            ],
          },
        },
      });
    });

    it("lets API Gateway invoke the alias for each route only, on the API's stage", () => {
      template.resourceCountIs("AWS::Lambda::Permission", 2);

      template.allResourcesProperties(
        "AWS::Lambda::Permission",
        Match.objectEquals({
          Action: "lambda:InvokeFunction",
          FunctionName: { Ref: Match.stringLikeRegexp("^domainoneAlias") },
          Principal: "apigateway.amazonaws.com",
          SourceArn: Match.anyValue(),
        }),
      );

      template.hasResourceProperties("AWS::Lambda::Permission", {
        SourceArn: permissionSourceArn("GET", "/a"),
      });

      template.hasResourceProperties("AWS::Lambda::Permission", {
        SourceArn: permissionSourceArn("PUT", "/a/*"),
      });
    });

    it("grants no test-invoke permission", () => {
      expect(JSON.stringify(template.toJSON())).not.toContain(
        "test-invoke-stage",
      );
    });
  });

  describe("host", () => {
    const template = synthDomainTemplate();

    it("maps the domain's host to the API's stage, at its root", () => {
      template.hasResourceProperties(
        "AWS::ApiGateway::BasePathMapping",
        Match.objectEquals({
          DomainName: HOST_NAME,
          RestApiId: { Ref: Match.stringLikeRegexp("^domainoneApi") },
          Stage: {
            Ref: Match.stringLikeRegexp("^domainoneApiDeploymentStageprod"),
          },
        }),
      );
    });

    it("turns off the execute-api endpoint, so the host is the only way in", () => {
      template.hasResourceProperties("AWS::ApiGateway::RestApi", {
        DisableExecuteApiEndpoint: true,
      });
    });

    it("outputs nothing, since the host is derived from config", () => {
      expect(template.toJSON()).not.toHaveProperty("Outputs");
    });
  });

  describe("execution role", () => {
    function roleStatements(template: Template): unknown[] {
      const [role] = Object.values(template.findResources("AWS::IAM::Role"));

      const { Policies } = role?.Properties as {
        Policies: { PolicyDocument: { Statement: unknown[] } }[];
      };

      return Policies.flatMap(({ PolicyDocument }) => PolicyDocument.Statement);
    }

    const template = synthDomainTemplate();

    it("is the domain's own, named as its function is, and trusts Lambda alone", () => {
      template.hasResourceProperties("AWS::IAM::Role", {
        RoleName: "domain-development-domain-one",
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: "sts:AssumeRole",
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
            },
          ],
        },
        ManagedPolicyArns: Match.absent(),
      });

      template.hasResourceProperties("AWS::Lambda::Function", {
        Role: {
          "Fn::GetAtt": [
            Match.stringLikeRegexp("^domainoneExecutionRole"),
            "Arn",
          ],
        },
      });
    });

    it("holds every permission in its own inline policy, which the function waits for", () => {
      template.resourceCountIs("AWS::IAM::Policy", 0);
    });

    it("writes to the domain's own log group alone, and writes traces", () => {
      template.hasResourceProperties("AWS::IAM::Role", {
        Policies: [
          {
            PolicyName: "Execution",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "WriteOwnLogs",
                  Effect: "Allow",
                  Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                  Resource: {
                    "Fn::GetAtt": [
                      Match.stringLikeRegexp("^domainoneFunctionLogs"),
                      "Arn",
                    ],
                  },
                },
                {
                  Sid: "WriteTraces",
                  Effect: "Allow",
                  Action: ["xray:PutTelemetryRecords", "xray:PutTraceSegments"],
                  Resource: "*",
                },
                {
                  Sid: "ManageNetworkInterfaces",
                  Effect: "Allow",
                  Action: [
                    "ec2:AssignPrivateIpAddresses",
                    "ec2:CreateNetworkInterface",
                    "ec2:DeleteNetworkInterface",
                    "ec2:DescribeNetworkInterfaces",
                    "ec2:DescribeSubnets",
                    "ec2:UnassignPrivateIpAddresses",
                  ],
                  Resource: "*",
                },
              ].map((statement) => Match.objectEquals(statement)),
            },
          },
        ],
      });
    });

    it("manages no network interfaces for a domain outside the VPC", () => {
      const statements = roleStatements(
        synthDomainTemplate({ ...DOMAIN_CONFIG, access: "public" }),
      );

      expect(
        statements.map((statement) => (statement as { Sid: string }).Sid),
      ).toEqual(["WriteOwnLogs", "WriteTraces"]);
    });

    it("is a role per domain, so two domains share no permissions", () => {
      const { stack } = createTestStack();

      new Domain(stack, "domain-one", {
        config: DOMAIN_CONFIG,
        ...SHARED_RESOURCES,
      });
      new Domain(stack, "domain-two", {
        config: { ...DOMAIN_CONFIG, name: "domain-two" },
        ...SHARED_RESOURCES,
        hostName: HOST_NAME.replace("domain-one", "domain-two"),
      });

      const template = Template.fromStack(stack);

      template.resourceCountIs("AWS::IAM::Role", 2);
      template.hasResourceProperties("AWS::IAM::Role", {
        RoleName: "domain-development-domain-two",
      });
    });
  });

  describe("stage and function settings", () => {
    const template = synthDomainTemplate();

    it("runs an empty Not Implemented response until a release", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Code: {
          ZipFile: "exports.handler = async () => ({ statusCode: 501 });",
        },
      });
    });

    it("takes the platform's defaults for settings the config leaves out", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Timeout: 15,
        MemorySize: 1024,
      });
    });

    it("takes the settings the config sets", () => {
      const tuned = synthDomainTemplate({
        ...DOMAIN_CONFIG,
        function: { timeoutSeconds: 25, memorySize: 512 },
      });

      tuned.hasResourceProperties("AWS::Lambda::Function", {
        Timeout: 25,
        MemorySize: 512,
      });
    });

    it("keeps the default for a setting the config leaves out beside one it sets", () => {
      const tuned = synthDomainTemplate({
        ...DOMAIN_CONFIG,
        function: { memorySize: 256 },
      });

      tuned.hasResourceProperties("AWS::Lambda::Function", {
        Timeout: 15,
        MemorySize: 256,
      });
    });

    it("traces, records metrics and logs errors only, never bodies", () => {
      template.hasResourceProperties("AWS::ApiGateway::Stage", {
        TracingEnabled: true,
        MethodSettings: [
          Match.objectLike({
            HttpMethod: "*",
            ResourcePath: "/*",
            LoggingLevel: "ERROR",
            DataTraceEnabled: false,
            MetricsEnabled: true,
          }),
        ],
      });
    });

    it("logs the function to its own retained log group", () => {
      template.hasResource("AWS::Logs::LogGroup", {
        DeletionPolicy: "Retain",
        Properties: {
          LogGroupName: "/flex/domain/development/domain-one/function",
          RetentionInDays: 365,
        },
      });

      template.hasResourceProperties("AWS::Lambda::Function", {
        LoggingConfig: {
          LogGroup: { Ref: Match.stringLikeRegexp("^domainoneFunctionLogs") },
        },
      });
    });

    it("writes access logs to a retained log group of their own, with the X-Ray trace ID", () => {
      const [stage] = Object.values(
        template.findResources("AWS::ApiGateway::Stage"),
      );

      const { Format } = (
        stage?.Properties as { AccessLogSetting: { Format: string } }
      ).AccessLogSetting;

      template.hasResourceProperties("AWS::ApiGateway::Stage", {
        AccessLogSetting: {
          DestinationArn: {
            "Fn::GetAtt": [
              Match.stringLikeRegexp("^domainoneApiAccessLogs"),
              "Arn",
            ],
          },
          Format: Match.anyValue(),
        },
      });

      template.hasResource("AWS::Logs::LogGroup", {
        DeletionPolicy: "Retain",
        Properties: {
          LogGroupName: "/flex/domain/development/domain-one/api-access",
          RetentionInDays: 365,
        },
      });

      expect(JSON.parse(Format)).toEqual({
        requestId: "$context.requestId",
        xrayTraceId: "$context.xrayTraceId",
        requestTime: "$context.requestTime",
        ip: "$context.identity.sourceIp",
        caller: "$context.identity.caller",
        user: "$context.identity.user",
        httpMethod: "$context.httpMethod",
        resourcePath: "$context.resourcePath",
        protocol: "$context.protocol",
        status: "$context.status",
        responseLength: "$context.responseLength",
      });
    });

    it("creates the stage's execution log group ahead of API Gateway, retained and encrypted", () => {
      template.hasResource("AWS::Logs::LogGroup", {
        DeletionPolicy: "Retain",
        Properties: {
          LogGroupName: {
            "Fn::Join": [
              "",
              [
                "API-Gateway-Execution-Logs_",
                { Ref: Match.stringLikeRegexp("^domainoneApi") },
                "/prod",
              ],
            ],
          },
          RetentionInDays: 365,
          KmsKeyId: Match.anyValue(),
        },
      });

      template.hasResource("AWS::ApiGateway::Stage", {
        DependsOn: Match.arrayWith([
          Match.stringLikeRegexp("^domainoneApiExecutionLogs"),
        ]),
      });
    });

    it("traces the function", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        TracingConfig: { Mode: "Active" },
      });
    });
  });

  // The app runs cdk-nag on every stack.
  it.each(["isolated", "private", "public"] as const)(
    "passes the AWS Solutions checks when %s",
    (access) => {
      const { app, stack } = createTestStack();

      Validations.of(app).addPlugins(new AwsSolutionsChecks(app));

      new Domain(stack, "domain-one", {
        config: { ...DOMAIN_CONFIG, access },
        ...SHARED_RESOURCES,
      });

      expect(() => app.synth()).not.toThrow();
    },
  );

  describe("resource policy", () => {
    it("admits the Frontdoor's role and denies everyone else", () => {
      const template = synthDomainTemplate();

      template.hasResourceProperties("AWS::ApiGateway::RestApi", {
        Policy: {
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "AllowFrontdoorRole",
              Effect: "Allow",
              Principal: { AWS: `arn:aws:iam::${FRONTDOOR_ACCOUNT}:root` },
              Action: "execute-api:Invoke",
              Resource: "execute-api:/*",
              Condition: {
                ArnEquals: { "aws:PrincipalArn": FRONTDOOR_ROLE_ARN },
              },
            },
            {
              Sid: "DenyEveryoneElse",
              Effect: "Deny",
              Principal: { AWS: "*" },
              Action: "execute-api:Invoke",
              Resource: "execute-api:/*",
              Condition: {
                ArnNotEquals: { "aws:PrincipalArn": FRONTDOOR_ROLE_ARN },
              },
            },
          ],
        },
      });
    });

    it("deploys the API again when the policy changes", () => {
      const before = synthDomainTemplate();

      const after = synthDomainTemplate(DOMAIN_CONFIG, {
        frontdoorRoleArn: "arn:aws:iam::100000000009:role/frontdoor",
      });

      expect(getLogicalIds(after, "AWS::ApiGateway::Deployment")).not.toEqual(
        getLogicalIds(before, "AWS::ApiGateway::Deployment"),
      );
    });
  });

  describe("access levels", () => {
    // Acceptance test, scenario 2.
    describe("given a config with no access level", () => {
      const template = synthDomainTemplate();

      it("places the function in the isolated subnets, behind the isolated security group", () => {
        template.hasResourceProperties("AWS::Lambda::Function", {
          VpcConfig: Match.objectEquals({
            SubnetIds: ISOLATED_SUBNET_IDS,
            SecurityGroupIds: [ISOLATED_SECURITY_GROUP_ID],
          }),
        });
      });

      it("creates no network resources of its own", () => {
        template.resourceCountIs("AWS::EC2::SecurityGroup", 0);
        template.resourceCountIs("AWS::EC2::SecurityGroupEgress", 0);
        template.resourceCountIs("AWS::EC2::SecurityGroupIngress", 0);
      });
    });

    it("places an isolated domain the same as the default", () => {
      const template = synthDomainTemplate({
        ...DOMAIN_CONFIG,
        access: "isolated",
      });

      template.hasResourceProperties("AWS::Lambda::Function", {
        VpcConfig: Match.objectEquals({
          SubnetIds: ISOLATED_SUBNET_IDS,
          SecurityGroupIds: [ISOLATED_SECURITY_GROUP_ID],
        }),
      });
    });

    it("places a private domain in the private subnets, behind the private security group", () => {
      const template = synthDomainTemplate({
        ...DOMAIN_CONFIG,
        access: "private",
      });

      template.hasResourceProperties("AWS::Lambda::Function", {
        VpcConfig: Match.objectEquals({
          SubnetIds: PRIVATE_SUBNET_IDS,
          SecurityGroupIds: [PRIVATE_SECURITY_GROUP_ID],
        }),
      });
    });

    it("runs a public domain outside the VPC", () => {
      const template = synthDomainTemplate({
        ...DOMAIN_CONFIG,
        access: "public",
      });

      template.hasResourceProperties("AWS::Lambda::Function", {
        VpcConfig: Match.absent(),
      });
    });

    // Replacing the function would lose its released versions.
    it("keeps the function's logical ID at every access level", () => {
      const functionIds = (["isolated", "private", "public"] as const).map(
        (access) =>
          getLogicalIds(
            synthDomainTemplate({ ...DOMAIN_CONFIG, access }),
            "AWS::Lambda::Function",
          ),
      );

      expect(new Set(functionIds.map((ids) => ids.join()))).toHaveLength(1);
    });

    it("refuses a placement with no subnets", () => {
      expect(() =>
        buildDomain({
          config: DOMAIN_CONFIG,
          ...SHARED_RESOURCES,
          network: {
            ...NETWORK,
            isolated: { ...ISOLATED_PLACEMENT, subnetIds: [] },
          },
        }),
      ).toThrow(
        "domain-one domain's network: the isolated placement has no subnets",
      );
    });

    it("refuses a private domain on a network with no private placement", () => {
      expect(() =>
        buildDomain({
          config: { ...DOMAIN_CONFIG, access: "private" },
          ...SHARED_RESOURCES,
          network: { isolated: ISOLATED_PLACEMENT },
        }),
      ).toThrow(
        "The domain-one domain is private, and its domain account's network has no private placement",
      );
    });

    it("refuses an isolated domain on an account with no network", () => {
      expect(() =>
        buildDomain({
          config: DOMAIN_CONFIG,
          ...SHARED_RESOURCES,
          network: {},
        }),
      ).toThrow(
        "The domain-one domain is isolated, and its domain account's network has no isolated placement",
      );
    });

    it("runs a public domain on an account with no network", () => {
      const template = synthDomainTemplate(
        { ...DOMAIN_CONFIG, access: "public" },
        { network: {} },
      );

      template.hasResourceProperties("AWS::Lambda::Function", {
        VpcConfig: Match.absent(),
      });
    });

    it("places an isolated domain on a network with no private placement", () => {
      const template = synthDomainTemplate(DOMAIN_CONFIG, {
        network: { isolated: ISOLATED_PLACEMENT },
      });

      template.hasResourceProperties("AWS::Lambda::Function", {
        VpcConfig: Match.objectEquals({
          SubnetIds: ISOLATED_SUBNET_IDS,
          SecurityGroupIds: [ISOLATED_SECURITY_GROUP_ID],
        }),
      });
    });

    // Lambda finds the VPC and the zones from the subnets, so nothing names either.
    it("imports no VPC", () => {
      const template = synthDomainTemplate();

      expect(JSON.stringify(template.toJSON())).not.toMatch(
        /vpc-|eu-west-2[abc]/,
      );
    });

    it("refuses a malformed network before building anything", () => {
      const { stack } = createTestStack();

      expect(
        () =>
          new Domain(stack, "domain-one", {
            config: DOMAIN_CONFIG,
            ...SHARED_RESOURCES,
            network: {
              ...NETWORK,
              isolated: { ...ISOLATED_PLACEMENT, securityGroupId: "sg-1" },
            },
          }),
      ).toThrow(
        'domain-one domain\'s network: "sg-1" is not a security group ID',
      );

      expect(stack.node.tryFindChild("domain-one")).toBeUndefined();
    });
  });

  describe("routes", () => {
    it("builds a method on the root and on nested parameter paths", () => {
      const template = synthDomainTemplate({
        name: "domain-one",
        routes: [
          { method: "GET", path: "/" },
          { method: "GET", path: "/a/{id}" },
          { method: "DELETE", path: "/a/{id}/b" },
        ],
      });

      template.resourceCountIs("AWS::ApiGateway::Method", 3);
      template.resourceCountIs("AWS::Lambda::Permission", 3);

      template.hasResourceProperties("AWS::ApiGateway::Resource", {
        PathPart: "{id}",
      });

      template.hasResourceProperties("AWS::Lambda::Permission", {
        SourceArn: permissionSourceArn("GET", "/"),
      });

      template.hasResourceProperties("AWS::Lambda::Permission", {
        SourceArn: permissionSourceArn("DELETE", "/a/*/b"),
      });
    });

    it("gives the same logical IDs whatever order the routes are in", () => {
      const routes: RouteConfig[] = [
        { method: "GET", path: "/a" },
        { method: "POST", path: "/a/b" },
        { method: "GET", path: "/c/{id}" },
      ];

      const forwards = synthDomainTemplate({ name: "domain-one", routes });

      const backwards = synthDomainTemplate({
        name: "domain-one",
        routes: [...routes].reverse(),
      });

      for (const type of [
        "AWS::ApiGateway::Method",
        "AWS::ApiGateway::Resource",
        "AWS::Lambda::Permission",
      ]) {
        expect(getLogicalIds(backwards, type)).toEqual(
          getLogicalIds(forwards, type),
        );
      }
    });
  });

  // A change to these replaces the resource and serves the placeholder again. Change them only on
  // purpose.
  it("keeps the logical IDs of the function, the placeholder version and the alias", () => {
    const template = synthDomainTemplate();

    expect({
      function: getLogicalIds(template, "AWS::Lambda::Function"),
      version: getLogicalIds(template, "AWS::Lambda::Version"),
      alias: getLogicalIds(template, "AWS::Lambda::Alias"),
    }).toEqual({
      function: ["domainoneFunctionBA436BA3"],
      version: ["domainoneVersionFF9F43ED"],
      alias: ["domainoneAliasF881DD55"],
    });
  });

  it("refuses an invalid config before building anything", () => {
    const { stack } = createTestStack();

    expect(
      () =>
        new Domain(stack, "domain-one", {
          config: { name: "domain-one", routes: [] },
          ...SHARED_RESOURCES,
        }),
    ).toThrow("domain-one domain has no routes");

    expect(stack.node.tryFindChild("domain-one")).toBeUndefined();
  });
});
