import { functionRoleStatements } from "@repo/infra-constructs";
import { ArnFormat, Stack, Validations } from "aws-cdk-lib";
import {
  Effect,
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import type { IKey } from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

import {
  domainFunctionName,
  executionRoleName,
  functionLogGroupName,
} from "./names.ts";

export interface ExecutionRoleProps {
  readonly environment: string;
  readonly domain: string;
  /** The functions a domain may invoke, as a name pattern such as `gateway-dev-*`. */
  readonly gatewayFunctions: string;
  /** The key the domain's function log group is encrypted with. */
  readonly logGroupKey: IKey;
}

/**
 * The role one domain's function runs as. It may write only to that domain's log group, so a
 * domain's code can never write into another's. Its boundary holds the same limits, in case the
 * role is ever widened by mistake.
 */
export class ExecutionRole extends Construct {
  constructor(
    scope: Construct,
    id: string,
    { environment, domain, gatewayFunctions, logGroupKey }: ExecutionRoleProps,
  ) {
    super(scope, id);

    const stack = Stack.of(this);

    const gateways = stack.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: gatewayFunctions,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    const execution = functionRoleStatements(this, {
      logGroupName: functionLogGroupName(environment, domain),
      logGroupKey,
      functions: domainFunctionName(environment, "*"),
    });

    const statements = [
      // The pattern covers each gateway's qualifiers too, such as `:live`.
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["lambda:InvokeFunction"],
        resources: [gateways],
      }),
      ...execution.statements,
      // Lambda sends a function's traces as its role when tracing is active.
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["xray:PutTelemetryRecords", "xray:PutTraceSegments"],
        resources: ["*"],
      }),
    ];

    const boundary = new ManagedPolicy(this, "Boundary", {
      description: `The most the ${domain} domain's function may do in ${environment}`,
      statements,
    });

    const role = new Role(this, "Role", {
      roleName: executionRoleName(environment, domain),
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      permissionsBoundary: boundary,
      inlinePolicies: {
        Execution: new PolicyDocument({ statements }),
      },
    });

    for (const scope of [role, boundary]) {
      Validations.of(scope).acknowledge(
        ...execution.acknowledgements,
        {
          id: `AwsSolutions-IAM5[Resource::${gateways}]`,
          reason:
            "Every domain may invoke every gateway in its environment, by requirement. Gateways are named by this pattern, and only gateways have it.",
        },
        {
          id: "AwsSolutions-IAM5[Resource::*]",
          reason:
            "Only Lambda's network interface actions, which AWS requires on *, and X-Ray's, which support no resource ARN, take it. The role's statements are tested exactly, so no other * can be added unseen.",
        },
      );
    }
  }
}
