import type { CfnWebACL } from "aws-cdk-lib/aws-wafv2";

/** Named as AWS names it, which is also the metric name its blocks are published under. */
export type ManagedRuleGroup =
  | "AWSManagedRulesCommonRuleSet"
  | "AWSManagedRulesKnownBadInputsRuleSet"
  | "AWSManagedRulesSQLiRuleSet"
  | "AWSManagedRulesAmazonIpReputationList"
  | "AWSManagedRulesAnonymousIpList"
  | "AWSManagedRulesLinuxRuleSet"
  | "AWSManagedRulesUnixRuleSet";

/** In evaluation order. */
export const DEFAULT_MANAGED_RULE_GROUPS: readonly ManagedRuleGroup[] = [
  "AWSManagedRulesCommonRuleSet",
  "AWSManagedRulesKnownBadInputsRuleSet",
  "AWSManagedRulesSQLiRuleSet",
  "AWSManagedRulesAmazonIpReputationList",
];

export const RATE_LIMIT_RULE_NAME = "RateLimitPerIp";

/** The status a rate limited request is answered with, so a client can tell it from a block. */
export const RATE_LIMIT_RESPONSE_CODE = 429;

function visibility(metricName: string): CfnWebACL.VisibilityConfigProperty {
  return {
    cloudWatchMetricsEnabled: true,
    metricName,
    sampledRequestsEnabled: true,
  };
}

export function managedRuleGroupRule(
  name: ManagedRuleGroup,
  priority: number,
): CfnWebACL.RuleProperty {
  return {
    name,
    priority,
    // `none` keeps the rule group's own actions; `count` would turn its blocks into counts.
    overrideAction: { none: {} },
    statement: {
      managedRuleGroupStatement: { vendorName: "AWS", name },
    },
    visibilityConfig: visibility(name),
  };
}

export function rateLimitRule(
  requestsPerFiveMinutes: number,
  priority: number,
): CfnWebACL.RuleProperty {
  return {
    name: RATE_LIMIT_RULE_NAME,
    priority,
    action: {
      block: {
        customResponse: { responseCode: RATE_LIMIT_RESPONSE_CODE },
      },
    },
    statement: {
      rateBasedStatement: {
        limit: requestsPerFiveMinutes,
        evaluationWindowSec: 300,
        aggregateKeyType: "IP",
      },
    },
    visibilityConfig: visibility(RATE_LIMIT_RULE_NAME),
  };
}
