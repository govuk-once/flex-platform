import { PlatformLogGroup } from "@repo/infra-constructs";
import { Validations } from "aws-cdk-lib";
import {
  AuthorizationType,
  CfnBasePathMapping,
  EndpointType,
  LambdaIntegration,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import type { IRole } from "aws-cdk-lib/aws-iam";
import {
  AccountPrincipal,
  AnyPrincipal,
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import type { CfnFunction, IFunction, IVersion } from "aws-cdk-lib/aws-lambda";
import {
  Alias,
  Architecture,
  Code,
  Function,
  Runtime,
  Tracing,
  Version,
} from "aws-cdk-lib/aws-lambda";
import type { ILogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import type { DomainConfig } from "./config.ts";
import { functionSettingsFor } from "./function.ts";
import {
  apiAccessLogGroupName,
  apiExecutionLogGroupName,
  domainResourceName,
  functionLogGroupName,
} from "./names.ts";
import type { DomainNetwork, NetworkPlacement } from "./network.ts";
import { placementFor, validateNetwork, vpcConfigFor } from "./network.ts";
import { domainStageOptions, STAGE_NAME } from "./stage.ts";
import { validateDomain } from "./validate.ts";

// Must never change: a deploy would overwrite the released code in $LATEST with it.
const HANDLER_CODE = "exports.handler = async () => ({ statusCode: 501 });";

// What Lambda does with the function's role to give it network interfaces in its subnets.
const NETWORK_INTERFACE_ACTIONS = [
  "ec2:AssignPrivateIpAddresses",
  "ec2:CreateNetworkInterface",
  "ec2:DeleteNetworkInterface",
  "ec2:DescribeNetworkInterfaces",
  "ec2:DescribeSubnets",
  "ec2:UnassignPrivateIpAddresses",
];

export interface DomainProps {
  readonly config: DomainConfig;
  readonly environment: string;
  /** The API Gateway domain name the domain account's stack creates for this domain. */
  readonly hostName: string;
  /** The role the Frontdoor signs each request with. The only caller the API admits. */
  readonly frontdoorRoleArn: string;
  /** The domain account's network. A domain that runs outside the VPC reads nothing from it. */
  readonly network: DomainNetwork;
}

interface DomainFunctionOptions {
  readonly environment: string;
  readonly placement: NetworkPlacement | undefined;
}

interface ExecutionRoleOptions {
  readonly name: string;
  readonly logGroup: ILogGroup;
  readonly placement: NetworkPlacement | undefined;
}

interface DomainApiOptions {
  readonly environment: string;
  readonly alias: Alias;
  readonly frontdoorRole: IRole;
}

interface HostMappingOptions {
  readonly hostName: string;
}

// Everything that hosts one domain.
//
// Construct IDs are a contract: renaming one replaces the resource. A replaced alias loses the
// release pipeline's pointer and serves the placeholder again.
export class Domain extends Construct {
  constructor(scope: Construct, id: string, props: DomainProps) {
    const { config, environment, hostName, frontdoorRoleArn, network } = props;

    validateDomain(config, { environment });
    validateNetwork(network, { at: `${config.name} domain's network` });

    const placement = placementFor(config, network);

    super(scope, id);

    const frontdoorRole = Role.fromRoleArn(
      this,
      "FrontdoorRole",
      frontdoorRoleArn,
      { mutable: false },
    );

    const alias = this.buildFunction(config, { environment, placement });
    const api = this.buildApi(config, { environment, alias, frontdoorRole });

    this.buildHostMapping(api, { hostName });
  }

  private buildFunction(
    config: DomainConfig,
    { environment, placement }: DomainFunctionOptions,
  ): Alias {
    const name = domainResourceName(config.name, { environment });

    const { logGroup } = new PlatformLogGroup(this, "FunctionLogs", {
      logGroupName: functionLogGroupName(config.name, { environment }),
    });

    const role = this.buildExecutionRole({ name, logGroup, placement });

    const domainFunction = new Function(this, "Function", {
      functionName: name,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.X86_64,
      handler: "index.handler",
      code: Code.fromInline(HANDLER_CODE),
      // Every permission is in the role's own inline policy. CDK would otherwise add X-Ray's to a
      // separate policy, which the function doesn't wait for.
      role: role.withoutPolicyUpdates(),
      logGroup,
      tracing: Tracing.ACTIVE,
      ...functionSettingsFor(config.function),
    });

    if (placement !== undefined) {
      (domainFunction.node.defaultChild as CfnFunction).vpcConfig =
        vpcConfigFor(placement);
    }

    // Published once, from the placeholder. currentVersion would publish whatever $LATEST holds at each deploy.
    const version = new Version(this, "Version", {
      lambda: domainFunction,
    });

    // Version and Alias type `role` as `IRole | undefined`, which exactOptionalPropertyTypes refuses for the interfaces they implement.
    return new Alias(this, "Alias", {
      aliasName: "live",
      version: version as IVersion,
    });
  }

  // The domain's own role: it reaches nothing of another domain's. A domain's grants, such as the
  // gateways it calls, are added here.
  private buildExecutionRole({
    name,
    logGroup,
    placement,
  }: ExecutionRoleOptions): Role {
    const statements = [
      new PolicyStatement({
        sid: "WriteOwnLogs",
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [logGroup.logGroupArn],
      }),
      new PolicyStatement({
        sid: "WriteTraces",
        actions: ["xray:PutTelemetryRecords", "xray:PutTraceSegments"],
        resources: ["*"],
      }),
    ];

    if (placement !== undefined) {
      statements.push(
        new PolicyStatement({
          sid: "ManageNetworkInterfaces",
          actions: NETWORK_INTERFACE_ACTIONS,
          resources: ["*"],
        }),
      );
    }

    const role = new Role(this, "ExecutionRole", {
      roleName: name,
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        Execution: new PolicyDocument({ statements }),
      },
    });

    Validations.of(role).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason:
        "X-Ray's writes, and the network interface actions Lambda takes for a function in a VPC, apply to no resource ARN.",
    });

    return role;
  }

  private buildApi(
    config: DomainConfig,
    { environment, alias, frontdoorRole }: DomainApiOptions,
  ): RestApi {
    const { logGroup: accessLogGroup } = new PlatformLogGroup(
      this,
      "ApiAccessLogs",
      { logGroupName: apiAccessLogGroupName(config.name, { environment }) },
    );

    // The custom domain is the only way in, so the Frontdoor's routing map is the only route.
    const api = new RestApi(this, "Api", {
      restApiName: domainResourceName(config.name, { environment }),
      endpointConfiguration: {
        types: [EndpointType.REGIONAL],
      },
      disableExecuteApiEndpoint: true,
      defaultMethodOptions: {
        authorizationType: AuthorizationType.IAM,
      },
      policy: frontdoorOnlyPolicy(frontdoorRole),
      deployOptions: domainStageOptions(accessLogGroup),
    });

    // CDK outputs the execute-api URL, which answers nothing once that endpoint is off.
    api.node.tryRemoveChild("Endpoint");

    // API Gateway would otherwise create it on the first error, unencrypted and kept forever.
    const executionLogs = new PlatformLogGroup(this, "ApiExecutionLogs", {
      logGroupName: apiExecutionLogGroupName(api.restApiId, STAGE_NAME),
    });

    api.deploymentStage.node.addDependency(executionLogs);

    Validations.of(api).acknowledge(
      {
        id: "AwsSolutions-APIG2",
        reason:
          "Every route is a Lambda proxy integration with no request models. The domain's handler validates each request it receives.",
      },
      {
        id: "AwsSolutions-COG4",
        reason:
          "The Frontdoor verifies the caller's Cognito token at the edge, then signs the request with SigV4. The API verifies that signature with IAM authorisation.",
      },
      {
        id: "AwsSolutions-APIG3",
        reason:
          "The Frontdoor's web ACL inspects every request at the edge. The resource policy and IAM authorisation refuse any request the Frontdoor's role did not sign.",
      },
    );

    const integration = new LambdaIntegration(alias as IFunction, {
      allowTestInvoke: false,
    });

    for (const { method, path } of config.routes) {
      api.root.resourceForPath(path).addMethod(method, integration);
    }

    return api;
  }

  // The API Gateway domain name is the domain account stack's, so it's named here, not referenced.
  private buildHostMapping(
    api: RestApi,
    { hostName }: HostMappingOptions,
  ): CfnBasePathMapping {
    return new CfnBasePathMapping(this, "HostMapping", {
      domainName: hostName,
      restApiId: api.restApiId,
      stage: api.deploymentStage.stageName,
    });
  }
}

function frontdoorOnlyPolicy(role: IRole): PolicyDocument {
  return new PolicyDocument({
    statements: [
      new PolicyStatement({
        sid: "AllowFrontdoorRole",
        effect: Effect.ALLOW,
        principals: [new AccountPrincipal(role.env.account)],
        actions: ["execute-api:Invoke"],
        resources: ["execute-api:/*"],
        conditions: {
          ArnEquals: { "aws:PrincipalArn": role.roleArn },
        },
      }),

      new PolicyStatement({
        sid: "DenyEveryoneElse",
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ["execute-api:Invoke"],
        resources: ["execute-api:/*"],
        conditions: {
          ArnNotEquals: { "aws:PrincipalArn": role.roleArn },
        },
      }),
    ],
  });
}
