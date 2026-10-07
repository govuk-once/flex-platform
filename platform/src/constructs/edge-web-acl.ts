import { ArnFormat, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Effect, PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { LogGroup, type RetentionDays } from "aws-cdk-lib/aws-logs";
import { CfnLoggingConfiguration, CfnWebACL } from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

import {
  DEFAULT_MANAGED_RULE_GROUPS,
  type ManagedRuleGroup,
  managedRuleGroupRule,
  type RateLimitRule,
  rateLimitRule,
} from "./waf-rules.ts";

/** WAF only accepts a CloudWatch log group whose name starts with this as a log destination. */
export const WAF_LOG_GROUP_PREFIX = "aws-waf-logs-";

/** Substituted in sampled requests and redacted in logs, so a credential reaches neither. */
export const REDACTED_HEADERS: readonly string[] = ["authorization", "cookie"];

export interface EdgeWebAclProps {
  /** Also the web ACL's metric name and the suffix of its log group's name. */
  readonly name: string;
  /** In evaluation order; `DEFAULT_MANAGED_RULE_GROUPS` when left out. */
  readonly managedRuleGroups?: readonly ManagedRuleGroup[];
  readonly rateLimit: RateLimitRule;
  readonly logRetention: RetentionDays;
  readonly retainLogsOnDelete: boolean;
}

/**
 * WAF accepts a CloudFront web ACL, its logging configuration and the log group it writes to in
 * us-east-1 only, so the construct refuses any other region at synth time.
 */
export class EdgeWebAcl extends Construct {
  public readonly webAcl: CfnWebACL;
  public readonly logGroup: LogGroup;
  public readonly logGroupName: string;
  public readonly logKey: Key;
  /** In evaluation order; also the rules' metric names. */
  public readonly ruleNames: readonly string[];

  constructor(scope: Construct, id: string, props: EdgeWebAclProps) {
    super(scope, id);

    const stack = Stack.of(this);
    if (stack.region !== "us-east-1") {
      throw new Error(
        `A CloudFront web ACL must be created in us-east-1, not ${stack.region}`,
      );
    }

    const managedRuleGroups =
      props.managedRuleGroups ?? DEFAULT_MANAGED_RULE_GROUPS;

    const rules = [
      ...managedRuleGroups.map((group, index) =>
        managedRuleGroupRule(group, index),
      ),
      rateLimitRule(props.rateLimit, managedRuleGroups.length),
    ];
    this.ruleNames = rules.map((rule) => rule.name);

    this.webAcl = new CfnWebACL(this, "WebAcl", {
      name: props.name,
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: props.name,
        sampledRequestsEnabled: true,
      },
      dataProtectionConfig: {
        dataProtections: REDACTED_HEADERS.map((header) => ({
          action: "SUBSTITUTION",
          field: { fieldType: "SINGLE_HEADER", fieldKeys: [header] },
          excludeRuleMatchDetails: false,
          excludeRateBasedDetails: false,
        })),
      },
      rules,
    });

    // Any log group in the account and region may use the key, not only WAF's.
    this.logKey = new Key(this, "LogKey", {
      description: `Encrypts the log groups of ${props.name}`,
      enableKeyRotation: true,
      removalPolicy: props.retainLogsOnDelete
        ? RemovalPolicy.RETAIN
        : RemovalPolicy.DESTROY,
    });
    this.logKey.addToResourcePolicy(
      new PolicyStatement({
        sid: "AllowCloudWatchLogs",
        effect: Effect.ALLOW,
        principals: [
          new ServicePrincipal(`logs.${stack.region}.amazonaws.com`),
        ],
        actions: [
          "kms:Encrypt*",
          "kms:Decrypt*",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:Describe*",
        ],
        resources: ["*"],
        conditions: {
          ArnLike: {
            "kms:EncryptionContext:aws:logs:arn": stack.formatArn({
              service: "logs",
              resource: "log-group",
              resourceName: "*",
              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            }),
          },
        },
      }),
    );

    this.logGroupName = `${WAF_LOG_GROUP_PREFIX}${props.name}`;
    this.logGroup = new LogGroup(this, "LogGroup", {
      logGroupName: this.logGroupName,
      retention: props.logRetention,
      encryptionKey: this.logKey,
      removalPolicy: props.retainLogsOnDelete
        ? RemovalPolicy.RETAIN
        : RemovalPolicy.DESTROY,
    });

    new CfnLoggingConfiguration(this, "Logging", {
      resourceArn: this.webAcl.attrArn,
      // WAF wants the log group's ARN without the `:*` the attribute carries.
      logDestinationConfigs: [
        stack.formatArn({
          service: "logs",
          resource: "log-group",
          resourceName: this.logGroup.logGroupName,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
      redactedFields: REDACTED_HEADERS.map((header) => ({
        singleHeader: { Name: header },
      })),
    });
  }
}
