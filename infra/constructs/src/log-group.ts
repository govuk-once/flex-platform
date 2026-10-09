import { RemovalPolicy } from "aws-cdk-lib";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

/** Every platform log group keeps its logs this long, for now. */
export const LOG_RETENTION = RetentionDays.ONE_YEAR;

export interface PlatformLogGroupProps {
  /** Named only where something requires it, such as WAF's `aws-waf-logs-` prefix. */
  readonly logGroupName?: string;
}

/**
 * A log group of the platform's: kept for a year and retained when its stack is deleted. Log
 * forwarding will carry every account's log groups to the shared account, which is where any
 * longer term copy is made, so retention here is the same everywhere.
 */
export class PlatformLogGroup extends Construct {
  public readonly logGroup: LogGroup;

  constructor(scope: Construct, id: string, props: PlatformLogGroupProps = {}) {
    super(scope, id);

    this.logGroup = new LogGroup(this, "LogGroup", {
      retention: LOG_RETENTION,
      removalPolicy: RemovalPolicy.RETAIN,
      ...(props.logGroupName !== undefined && {
        logGroupName: props.logGroupName,
      }),
    });
  }
}
