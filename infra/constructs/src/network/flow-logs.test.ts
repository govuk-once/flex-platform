import { Match } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";

import { buildNetwork } from "../../test/network.ts";

describe("FlowLogs", () => {
  it("logs every flow in the VPC to its bucket, in hourly partitions", () => {
    buildNetwork().template.hasResourceProperties("AWS::EC2::FlowLog", {
      ResourceType: "VPC",
      ResourceId: { Ref: Match.stringLikeRegexp("^NetworkVpc") },
      TrafficType: "ALL",
      LogDestinationType: "s3",
      LogDestination: {
        "Fn::GetAtt": [Match.stringLikeRegexp("^FlowLogsStore"), "Arn"],
      },
      DestinationOptions: {
        fileFormat: "plain-text",
        hiveCompatiblePartitions: true,
        perHourPartition: true,
      },
    });
  });

  it("archives logs after a month and deletes them after a year, as log groups are kept, locked until then", () => {
    buildNetwork().template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: {
        ObjectLockConfiguration: {
          ObjectLockEnabled: "Enabled",
          Rule: { DefaultRetention: { Mode: "COMPLIANCE", Days: 365 } },
        },
        LifecycleConfiguration: {
          Rules: [
            {
              Status: "Enabled",
              Transitions: [
                { StorageClass: "GLACIER_IR", TransitionInDays: 30 },
              ],
              ExpirationInDays: 365,
              NoncurrentVersionExpiration: { NoncurrentDays: 1 },
            },
          ],
        },
      },
    });
  });

  it("sends the rejected flows alone to a log group of the platform's, for the central logs", () => {
    const { template } = buildNetwork();

    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/flex/network/sandbox/rejected-flows",
    });
    template.hasResourceProperties("AWS::EC2::FlowLog", {
      ResourceType: "VPC",
      ResourceId: { Ref: Match.stringLikeRegexp("^NetworkVpc") },
      TrafficType: "REJECT",
      LogDestinationType: "cloud-watch-logs",
      LogGroupName: { Ref: Match.stringLikeRegexp("^FlowLogsRejected") },
      DeliverLogsPermissionArn: {
        "Fn::GetAtt": [
          Match.stringLikeRegexp("^FlowLogsRejectedDelivery"),
          "Arn",
        ],
      },
    });
    template.resourceCountIs("AWS::EC2::FlowLog", 2);
  });
});
