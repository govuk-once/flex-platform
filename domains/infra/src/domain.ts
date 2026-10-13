import { PlatformLogGroup } from "@repo/infra-constructs/log-group";
import { Validations } from "aws-cdk-lib";
import {
  AuthorizationType,
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
} from "aws-cdk-lib/aws-iam";
import type { IFunction, IVersion } from "aws-cdk-lib/aws-lambda";
import {
  Alias,
  Architecture,
  Code,
  Function,
  Runtime,
  Tracing,
  Version,
} from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

import type { DomainConfig } from "./config.ts";
import { DEFAULT_ACCESS } from "./config.ts";
import { functionSettingsFor } from "./function.ts";
import {
  apiAccessLogGroupName,
  domainResourceName,
  functionLogGroupName,
} from "./names.ts";
import type { DomainNetwork } from "./network.ts";
import { vpcSettingsFor } from "./network.ts";
import { domainStageOptions } from "./stage.ts";
import { validateDomain } from "./validate.ts";

// Must never change: a deploy would overwrite the released code in $LATEST with it.
const HANDLER_CODE = "exports.handler = async () => ({ statusCode: 501 });";

export interface DomainProps {
  readonly config: DomainConfig;
  readonly executionRoleArn: string;
  readonly frontdoorRoleArn: string;
  readonly network: DomainNetwork;
}

interface DomainFunctionOptions {
  readonly network: DomainNetwork;
  readonly executionRole: IRole;
}

interface DomainApiOptions {
  readonly alias: Alias;
  readonly frontdoorRole: IRole;
}

// Everything that hosts one domain.
//
// Construct IDs are a contract: renaming one replaces the resource. A replaced alias loses the
// release pipeline's pointer and serves the placeholder again.
export class Domain extends Construct {
  constructor(scope: Construct, id: string, props: DomainProps) {
    const { config, executionRoleArn, frontdoorRoleArn, network } = props;

    validateDomain(config);

    super(scope, id);

    const executionRole = Role.fromRoleArn(
      this,
      "ExecutionRole",
      executionRoleArn,
      { mutable: false },
    );
    const frontdoorRole = Role.fromRoleArn(
      this,
      "FrontdoorRole",
      frontdoorRoleArn,
      { mutable: false },
    );

    const alias = this.buildFunction(config, { network, executionRole });

    this.buildApi(config, { alias, frontdoorRole });
  }

  private buildFunction(
    config: DomainConfig,
    { network, executionRole }: DomainFunctionOptions,
  ): Alias {
    const { access = DEFAULT_ACCESS } = config;

    const { logGroup } = new PlatformLogGroup(this, "FunctionLogs", {
      logGroupName: functionLogGroupName(config.name),
    });

    const fn = new Function(this, "Function", {
      functionName: domainResourceName(config.name),
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.X86_64,
      handler: "index.handler",
      code: Code.fromInline(HANDLER_CODE),
      role: executionRole,
      logGroup,
      tracing: Tracing.ACTIVE,
      ...functionSettingsFor(config.function),
      ...vpcSettingsFor(this, network, { access }),
    });

    // Published once, from the placeholder. fn.currentVersion would publish whatever $LATEST holds at each deploy.
    const version = new Version(this, "Version", {
      lambda: fn,
    });

    // Version and Alias type `role` as `IRole | undefined`, which exactOptionalPropertyTypes refuses for the interfaces they implement.
    return new Alias(this, "Alias", {
      aliasName: "live",
      version: version as IVersion,
    });
  }

  private buildApi(
    config: DomainConfig,
    { alias, frontdoorRole }: DomainApiOptions,
  ): RestApi {
    const { logGroup: accessLogGroup } = new PlatformLogGroup(
      this,
      "ApiAccessLogs",
      { logGroupName: apiAccessLogGroupName(config.name) },
    );

    const api = new RestApi(this, "Api", {
      restApiName: domainResourceName(config.name),
      endpointConfiguration: {
        types: [EndpointType.REGIONAL],
      },
      defaultMethodOptions: {
        authorizationType: AuthorizationType.IAM,
      },
      policy: frontdoorOnlyPolicy(frontdoorRole),
      deployOptions: domainStageOptions(accessLogGroup),
    });

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
