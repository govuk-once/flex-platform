import {
  logGroupWriteStatements,
  PlatformLogGroup,
} from "@repo/infra-constructs";
import { Stack, Validations } from "aws-cdk-lib";
import { ManagedPolicy } from "aws-cdk-lib/aws-iam";
import type { LogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import {
  originRequestLogGroupName,
  originRequestLogsPolicyName,
} from "./names.ts";

export interface OriginRequestLogsProps {
  readonly environment: string;
}

/**
 * The origin request function's log group in this stack's region, and the policy that lets the
 * function's role write to it. The role is in another stack and attaches the policy by its name,
 * so the policy can name this log group and its key exactly.
 */
export class OriginRequestLogs extends Construct {
  public readonly logGroup: LogGroup;
  public readonly policy: ManagedPolicy;

  constructor(scope: Construct, id: string, props: OriginRequestLogsProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const logGroupName = originRequestLogGroupName(props.environment);
    const { logGroup, key } = new PlatformLogGroup(this, "Group", {
      logGroupName,
    });
    this.logGroup = logGroup;

    const { statements, acknowledgements } = logGroupWriteStatements(this, {
      logGroupName,
      logGroupKey: key,
    });

    this.policy = new ManagedPolicy(this, "WritePolicy", {
      managedPolicyName: originRequestLogsPolicyName(
        props.environment,
        stack.region,
      ),
      statements,
    });
    Validations.of(this.policy).acknowledge(...acknowledgements);
  }
}
