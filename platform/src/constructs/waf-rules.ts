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

export interface RateLimitRule {
  readonly requestsPerWindow: number;
  /** WAF accepts only these windows; 300 when left out. */
  readonly windowSeconds?: 60 | 120 | 300 | 600;
  /** 429 when left out. */
  readonly responseCode?: number;
}

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
  rule: RateLimitRule,
  priority: number,
): CfnWebACL.RuleProperty {
  return {
    name: RATE_LIMIT_RULE_NAME,
    priority,
    action: {
      block: {
        customResponse: { responseCode: rule.responseCode ?? 429 },
      },
    },
    statement: {
      rateBasedStatement: {
        limit: rule.requestsPerWindow,
        evaluationWindowSec: rule.windowSeconds ?? 300,
        aggregateKeyType: "IP",
      },
    },
    visibilityConfig: visibility(RATE_LIMIT_RULE_NAME),
  };
}
