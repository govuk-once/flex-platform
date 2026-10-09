import { ArnFormat, RemovalPolicy, Stack } from "aws-cdk-lib";
import { LogGroup, type RetentionDays } from "aws-cdk-lib/aws-logs";
import { CfnLoggingConfiguration, CfnWebACL } from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

import { wafLogGroupName, webAclName } from "./names.ts";
import {
  DEFAULT_MANAGED_RULE_GROUPS,
  type ManagedRuleGroup,
  managedRuleGroupRule,
  rateLimitRule,
} from "./waf-rules.ts";

/** Substituted in sampled requests and redacted in logs, so a credential reaches neither. */
export const REDACTED_HEADERS: readonly string[] = ["authorization", "cookie"];

export interface WebAclProps {
  readonly environment: string;
  /** In evaluation order; `DEFAULT_MANAGED_RULE_GROUPS` when left out. */
  readonly managedRuleGroups?: readonly ManagedRuleGroup[];
  readonly rateLimitPerFiveMinutes: number;
  readonly logRetention: RetentionDays;
}

/**
 * WAF accepts a CloudFront web ACL, its logging configuration and the log group it writes to in
 * us-east-1 only, so the construct refuses any other region at synth time.
 */
export class WebAcl extends Construct {
  public readonly webAcl: CfnWebACL;
  public readonly logGroup: LogGroup;
  /** In evaluation order; also the rules' metric names. */
  public readonly ruleNames: readonly string[];

  constructor(scope: Construct, id: string, props: WebAclProps) {
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
      rateLimitRule(props.rateLimitPerFiveMinutes, managedRuleGroups.length),
    ];
    this.ruleNames = rules.map((rule) => rule.name);

    const name = webAclName(props.environment);
    this.webAcl = new CfnWebACL(this, "WebAcl", {
      name,
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: name,
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

    this.logGroup = new LogGroup(this, "LogGroup", {
      logGroupName: wafLogGroupName(props.environment),
      retention: props.logRetention,
      removalPolicy: RemovalPolicy.RETAIN,
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
