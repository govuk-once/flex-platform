import type { CfnWebACL } from "aws-cdk-lib/aws-wafv2";

/** Named as AWS names it, which is also the metric name its matches are published under. */
export type ManagedRuleGroup =
  | "AWSManagedRulesCommonRuleSet"
  | "AWSManagedRulesKnownBadInputsRuleSet"
  | "AWSManagedRulesSQLiRuleSet"
  | "AWSManagedRulesAnonymousIpList";

export const BODY_SIZE_RULE_NAME = "BodySizeLimit";
export const RATE_LIMIT_PER_TOKEN_RULE_NAME = "RateLimitPerToken";
export const RATE_LIMIT_PER_IP_RULE_NAME = "RateLimitPerIp";

/**
 * The largest body the edge lets through, in bytes. It's also how much of a body WAF inspects, so
 * the managed rules see the whole of every body that reaches the origin.
 */
export const BODY_SIZE_LIMIT = 16 * 1024;

/** The web ACL's inspection limit for a CloudFront body, which must equal `BODY_SIZE_LIMIT`. */
export const BODY_INSPECTION_LIMIT = "KB_16";

/** Requests one bearer token may make in five minutes before the edge turns it away. */
export const RATE_LIMIT_PER_TOKEN = 1000;

/** Requests one address may make in five minutes, above the per-token limit for shared networks. */
export const RATE_LIMIT_PER_IP = 5000;

const RATE_LIMIT_WINDOW_SECONDS = 300;

/** The JSON bodies WAF answers its own blocks with, by key; managed rule blocks keep WAF's 403. */
export const CUSTOM_RESPONSE_BODIES = {
  "body-too-large": {
    contentType: "APPLICATION_JSON",
    content: JSON.stringify({
      message: "Request body too large",
      type: "client_error",
    }),
  },
  "too-many-requests": {
    contentType: "APPLICATION_JSON",
    content: JSON.stringify({
      message: "Too many requests",
      type: "client_error",
    }),
  },
} as const satisfies Record<string, CfnWebACL.CustomResponseBodyProperty>;

type CustomResponseBody = keyof typeof CUSTOM_RESPONSE_BODIES;

function visibility(metricName: string): CfnWebACL.VisibilityConfigProperty {
  return {
    cloudWatchMetricsEnabled: true,
    metricName,
    sampledRequestsEnabled: true,
  };
}

function block(
  responseCode: number,
  body: CustomResponseBody,
): CfnWebACL.RuleActionProperty {
  return {
    block: { customResponse: { responseCode, customResponseBodyKey: body } },
  };
}

type UnprioritisedRule = Omit<CfnWebACL.RuleProperty, "priority">;

// A body over the inspection limit matches without being inspected, so `GT` on the inspected part
// alone would let it through.
function bodySizeRule(): UnprioritisedRule {
  return {
    name: BODY_SIZE_RULE_NAME,
    action: block(413, "body-too-large"),
    statement: {
      sizeConstraintStatement: {
        fieldToMatch: { body: { oversizeHandling: "MATCH" } },
        comparisonOperator: "GT",
        size: BODY_SIZE_LIMIT,
        textTransformations: [{ priority: 0, type: "NONE" }],
      },
    },
    visibilityConfig: visibility(BODY_SIZE_RULE_NAME),
  };
}

function managedRuleGroupRule(
  name: ManagedRuleGroup,
  options: { count?: boolean; countRules?: readonly string[] } = {},
): UnprioritisedRule {
  return {
    name,
    // `none` keeps the rule group's own actions; `count` turns every block into a count.
    overrideAction: options.count === true ? { count: {} } : { none: {} },
    statement: {
      managedRuleGroupStatement: {
        vendorName: "AWS",
        name,
        ...(options.countRules === undefined
          ? {}
          : {
              ruleActionOverrides: options.countRules.map((rule) => ({
                name: rule,
                actionToUse: { count: {} },
              })),
            }),
      },
    },
    visibilityConfig: visibility(name),
  };
}

function rateLimitRule(
  name: string,
  limit: number,
  key: Pick<
    CfnWebACL.RateBasedStatementProperty,
    "aggregateKeyType" | "customKeys"
  >,
): UnprioritisedRule {
  return {
    name,
    action: block(429, "too-many-requests"),
    statement: {
      rateBasedStatement: {
        limit,
        evaluationWindowSec: RATE_LIMIT_WINDOW_SECONDS,
        ...key,
      },
    },
    visibilityConfig: visibility(name),
  };
}

/** The web ACL's rules, in evaluation order, each with its priority. */
export function wafRules(): CfnWebACL.RuleProperty[] {
  const rules: UnprioritisedRule[] = [
    bodySizeRule(),
    // The body size rule answers an oversize body with a 413 first; this rule's 8 KB limit would
    // otherwise block bodies the platform accepts.
    managedRuleGroupRule("AWSManagedRulesCommonRuleSet", {
      countRules: ["SizeRestrictions_BODY"],
    }),
    managedRuleGroupRule("AWSManagedRulesKnownBadInputsRuleSet"),
    managedRuleGroupRule("AWSManagedRulesSQLiRuleSet"),
    // Counted, not blocked: its matches show in metrics and logs, and nobody is turned away.
    managedRuleGroupRule("AWSManagedRulesAnonymousIpList", { count: true }),
    // A request without the header isn't counted here; the CloudFront Function refuses it. The
    // header's exact value is the key, so both functions accept each token in one form only:
    // `Bearer`, one space, and the token in its canonical base64url.
    rateLimitRule(RATE_LIMIT_PER_TOKEN_RULE_NAME, RATE_LIMIT_PER_TOKEN, {
      aggregateKeyType: "CUSTOM_KEYS",
      customKeys: [
        {
          header: {
            name: "authorization",
            textTransformations: [{ priority: 0, type: "NONE" }],
          },
        },
      ],
    }),
    rateLimitRule(RATE_LIMIT_PER_IP_RULE_NAME, RATE_LIMIT_PER_IP, {
      aggregateKeyType: "IP",
    }),
  ];
  return rules.map((rule, priority) => ({ ...rule, priority }));
}
