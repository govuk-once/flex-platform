import { ArnFormat, Duration, Stack, Validations } from "aws-cdk-lib";
import {
  FlowLog,
  FlowLogDestination,
  FlowLogFileFormat,
  FlowLogResourceType,
  FlowLogTrafficType,
  type IVpc,
} from "aws-cdk-lib/aws-ec2";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { type Bucket, type IBucket, StorageClass } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

import { PlatformBucket } from "../bucket.ts";
import { PlatformLogGroup } from "../log-group.ts";
import { rejectedFlowLogGroupName } from "./names.ts";

/** As long as the platform keeps its log groups. */
export const FLOW_LOG_RETENTION = Duration.days(365);

/** After a month a flow log is read rarely, if ever. */
export const FLOW_LOG_ARCHIVE_AFTER = Duration.days(30);

export interface FlowLogsProps {
  readonly environment: string;
  readonly vpc: IVpc;
}

/**
 * Every flow in the VPC, accepted and rejected, to a bucket. S3 rather than CloudWatch Logs:
 * flow logs are the platform's largest log by far, S3's delivery costs half as much, and they
 * stay out of log forwarding, which would index every record. Hive-style hourly partitions, so
 * Athena can read a window without scanning the rest. AWS's default ten-minute aggregation: a
 * connection kept open is one record per direction every ten minutes, not every minute.
 *
 * The rejected flows go to a `PlatformLogGroup` as well, which log forwarding carries to the
 * central logs. A rejection is the security signal in a flow log, something misconfigured or
 * probing, and there should be few, so the cost of sending every flow there is avoided.
 */
export class FlowLogs extends Construct {
  public readonly bucket: Bucket;
  /** The rejected flows alone, for the central logs. */
  public readonly rejected: PlatformLogGroup;

  constructor(scope: Construct, id: string, props: FlowLogsProps) {
    super(scope, id);

    const { bucket } = new PlatformBucket(this, "Store", {
      lockedFor: FLOW_LOG_RETENTION,
    });
    bucket.addLifecycleRule({
      transitions: [
        {
          storageClass: StorageClass.GLACIER_INSTANT_RETRIEVAL,
          transitionAfter: FLOW_LOG_ARCHIVE_AFTER,
        },
      ],
      expiration: FLOW_LOG_RETENTION,
      // The lock keeps every version for the retention, however it stops being current; this
      // removes one once it is no longer current and its lock has ended, rather than a year later.
      noncurrentVersionExpiration: Duration.days(1),
    });
    Validations.of(bucket).acknowledge({
      id: "AwsSolutions-S1",
      reason:
        "The bucket holds only flow logs, which log delivery writes. Access logs for it would record little but those writes.",
    });
    this.bucket = bucket;

    new FlowLog(this, "FlowLog", {
      resourceType: FlowLogResourceType.fromVpc(props.vpc),
      trafficType: FlowLogTrafficType.ALL,
      // CDK declares Bucket's `isWebsite` as possibly undefined and IBucket's as optional, which
      // `exactOptionalPropertyTypes` won't match.
      destination: FlowLogDestination.toS3(bucket as IBucket, undefined, {
        fileFormat: FlowLogFileFormat.PLAIN_TEXT,
        hiveCompatiblePartitions: true,
        perHourPartition: true,
      }),
    });

    this.rejected = this.logRejected(props);
  }

  private logRejected({ environment, vpc }: FlowLogsProps): PlatformLogGroup {
    const stack = Stack.of(this);
    const logGroupName = rejectedFlowLogGroupName(environment);
    const rejected = new PlatformLogGroup(this, "Rejected", { logGroupName });
    const logGroupArn = stack.formatArn({
      service: "logs",
      resource: "log-group",
      resourceName: logGroupName,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    // CDK gives the role what it needs to write to the group; the key is ours to grant, through
    // CloudWatch Logs, for this log group alone.
    const role = new Role(this, "RejectedDelivery", {
      assumedBy: new ServicePrincipal("vpc-flow-logs.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": stack.account } },
      }),
    });
    role.addToPolicy(
      new PolicyStatement({
        actions: ["kms:Encrypt", "kms:GenerateDataKey*"],
        resources: [rejected.key.keyArn],
        conditions: {
          StringEquals: {
            "kms:ViaService": `logs.${stack.region}.amazonaws.com`,
          },
          ArnEquals: { "kms:EncryptionContext:aws:logs:arn": logGroupArn },
        },
      }),
    );

    new FlowLog(this, "RejectedFlowLog", {
      resourceType: FlowLogResourceType.fromVpc(vpc),
      trafficType: FlowLogTrafficType.REJECT,
      destination: FlowLogDestination.toCloudWatchLogs(rejected.logGroup, role),
    });

    Validations.of(role).acknowledge({
      id: "AwsSolutions-IAM5[Action::kms:GenerateDataKey*]",
      reason:
        "CloudWatch Logs chooses which GenerateDataKey call it makes; the grant holds only for the one key and log group.",
    });
    return rejected;
  }
}
