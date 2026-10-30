import type { TrustedIssuer } from "@repo/frontdoor-shared";
import { buildViewerRequestFunction } from "@repo/frontdoor-viewer-request";
import { PlatformLogGroup } from "@repo/infra-constructs";
import { ArnFormat, Stack } from "aws-cdk-lib";
import {
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionRuntime,
} from "aws-cdk-lib/aws-cloudfront";
import { AnyPrincipal, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { LogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import {
  viewerRequestFunctionName,
  viewerRequestLogGroupName,
} from "./names.ts";

// The service-linked role CloudFront writes function logs as, with its path.
const CLOUDFRONT_LOGGER_ROLE =
  "aws-service-role/logger.cloudfront.amazonaws.com/AWSServiceRoleForCloudFrontLogger";

export interface ViewerRequestFunctionProps {
  readonly environment: string;
  /** The user pools and app clients whose tokens the function lets through. */
  readonly issuers: readonly TrustedIssuer[];
}

/**
 * The CloudFront Function that checks each request's structure, built with an environment's
 * issuers, and the log group it writes to.
 *
 * CloudFront writes a function's logs to a group named after it, in us-east-1 whichever edge ran
 * it, and creates that group itself, with no retention, if it's missing. So the function's name
 * is derived from config, never changes, and its group is created first.
 */
export class ViewerRequestFunction extends Construct {
  public readonly function: CloudFrontFunction;
  public readonly logGroup: LogGroup;

  constructor(scope: Construct, id: string, props: ViewerRequestFunctionProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const { region } = stack;
    if (region !== "us-east-1") {
      throw new Error(
        `The viewer request function must be created in us-east-1, where CloudFront writes its logs, not ${region}`,
      );
    }

    const logGroupName = viewerRequestLogGroupName(props.environment);
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
      functionName: viewerRequestFunctionName(props.environment),
      code: FunctionCode.fromInline(
        buildViewerRequestFunction({ issuers: props.issuers }),
      ),
      runtime: FunctionRuntime.JS_2_0,
    });
    this.function.node.addDependency(this.logGroup);
  }
}
