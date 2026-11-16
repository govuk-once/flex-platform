import { ArnFormat, Stack } from "aws-cdk-lib";
import {
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionRuntime,
} from "aws-cdk-lib/aws-cloudfront";
import { AnyPrincipal, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { LogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import { PlatformLogGroup } from "../log-group.ts";

// The service-linked role CloudFront writes function logs as, with its path.
const CLOUDFRONT_LOGGER_ROLE =
  "aws-service-role/logger.cloudfront.amazonaws.com/AWSServiceRoleForCloudFrontLogger";

/** CloudFront writes a function's logs here, in us-east-1, and creates the group if it's missing. */
export function cloudFrontFunctionLogGroupName(functionName: string): string {
  return `/aws/cloudfront/function/${functionName}`;
}

export interface PlatformCloudFrontFunctionProps {
  /** Derived from config, and never changed: it names the log group CloudFront writes to. */
  readonly functionName: string;
  /** The function's code, built for the cloudfront-js-2.0 runtime. */
  readonly code: string;
}

/**
 * A CloudFront Function and the log group it writes to.
 *
 * CloudFront writes a function's logs to a group named after it, in us-east-1 whichever edge ran
 * it, and creates that group itself, with no retention, if it's missing. So the function's name
 * is derived from config, never changes, and its group is created first.
 */
export class PlatformCloudFrontFunction extends Construct {
  public readonly function: CloudFrontFunction;
  public readonly logGroup: LogGroup;

  constructor(
    scope: Construct,
    id: string,
    props: PlatformCloudFrontFunctionProps,
  ) {
    super(scope, id);

    const stack = Stack.of(this);
    const { region } = stack;
    if (region !== "us-east-1") {
      throw new Error(
        `A CloudFront Function must be created in us-east-1, where CloudFront writes its logs, not ${region}`,
      );
    }

    const logGroupName = cloudFrontFunctionLogGroupName(props.functionName);
    const { logGroup, key } = new PlatformLogGroup(this, "Logs", {
      logGroupName,
    });
    this.logGroup = logGroup;

    // CloudFront writes the function's logs as its logger role, whose policy is AWS's and holds no
    // KMS permissions, so the key grants it directly, for this log group alone. The role is matched
    // by ARN, not named as the principal: KMS refuses a policy naming a role that doesn't exist,
    // and CloudFront creates this one when it first needs it.
    key.addToResourcePolicy(
      new PolicyStatement({
        sid: "AllowCloudFrontFunctionLogs",
        effect: Effect.ALLOW,
        principals: [new AnyPrincipal()], // NOSONAR: the conditions hold it to the logger role
        actions: ["kms:Encrypt", "kms:GenerateDataKey*"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "kms:CallerAccount": stack.account,
            "kms:ViaService": `logs.${region}.amazonaws.com`,
          },
          ArnEquals: {
            "aws:PrincipalArn": stack.formatArn({
              service: "iam",
              region: "",
              resource: "role",
              resourceName: CLOUDFRONT_LOGGER_ROLE,
            }),
            "kms:EncryptionContext:aws:logs:arn": stack.formatArn({
              service: "logs",
              resource: "log-group",
              resourceName: logGroupName,
              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            }),
          },
        },
      }),
    );

    this.function = new CloudFrontFunction(this, "Function", {
      functionName: props.functionName,
      code: FunctionCode.fromInline(props.code),
      runtime: FunctionRuntime.JS_2_0,
    });
    this.function.node.addDependency(this.logGroup);
  }
}
