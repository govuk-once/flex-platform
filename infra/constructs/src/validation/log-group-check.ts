import { RetentionDays } from "aws-cdk-lib/aws-logs";

import { ResourceCheck } from "./resource-check.ts";

export const LOG_GROUP_RULE = "Flex-LogGroup";

/** A log group must keep its logs this long, for now. */
export const LOG_RETENTION = RetentionDays.ONE_YEAR;

/**
 * Fails synth on any log group that doesn't keep its logs for the platform's retention, isn't
 * encrypted with a KMS key, or isn't retained when its stack is deleted. It can't see a log group
 * an AWS service creates when it first writes, which is why those are created ahead of the
 * service.
 */
export class LogGroupCheck extends ResourceCheck {
  constructor() {
    super({
      name: LOG_GROUP_RULE,
      description: `A log group must keep its logs for ${String(LOG_RETENTION)} days, be encrypted with a KMS key, and be retained when its stack is deleted.`,
      fix: "Create it with PlatformLogGroup from @repo/infra-constructs.",
      type: "AWS::Logs::LogGroup",
      faults: (resource) => [
        ...(resource.Properties?.RetentionInDays === LOG_RETENTION
          ? []
          : ["Properties/RetentionInDays"]),
        ...(resource.Properties?.KmsKeyId === undefined
          ? ["Properties/KmsKeyId"]
          : []),
        ...(resource.DeletionPolicy === "Retain" ? [] : ["DeletionPolicy"]),
      ],
    });
  }
}
