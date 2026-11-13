import { ArnFormat, Stack } from "aws-cdk-lib";
import type { LogGroup } from "aws-cdk-lib/aws-logs";
import { CfnLoggingConfiguration, CfnWebACL } from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

import { PlatformLogGroup } from "../log-group.ts";
import {
  BODY_INSPECTION_LIMIT,
  CUSTOM_RESPONSE_BODIES,
  webAclRules,
  type WebAclRulesProps,
} from "./waf-rules.ts";

/** WAF only accepts a log group whose name starts with `aws-waf-logs-`. */
export function wafLogGroupName(webAclName: string): string {
  return `aws-waf-logs-${webAclName}`;
}

export interface CloudFrontWebAclProps extends WebAclRulesProps {
  /** Derived from config. It is also the web ACL's metric name, and names its log group. */
  readonly name: string;
  /** Substituted in sampled requests and redacted in logs, so a credential reaches neither. */
  readonly redactedHeaders: readonly string[];
}

/**
 * A distribution's web ACL, and the log group every request it evaluates is logged to.
 *
 * WAF accepts a CloudFront web ACL, its logging configuration and the log group it writes to in
 * us-east-1 only, so the construct refuses any other region at synth time.
 */
export class CloudFrontWebAcl extends Construct {
  public readonly webAcl: CfnWebACL;
  public readonly logGroup: LogGroup;
  /** In evaluation order; also the rules' metric names. */
  public readonly ruleNames: readonly string[];

  constructor(scope: Construct, id: string, props: CloudFrontWebAclProps) {
    super(scope, id);

    const stack = Stack.of(this);
    if (stack.region !== "us-east-1") {
      throw new Error(
        `A CloudFront web ACL must be created in us-east-1, not ${stack.region}`,
      );
    }

    const { name, redactedHeaders } = props;
    const rules = webAclRules(props);
    this.ruleNames = rules.map((rule) => rule.name);

    this.webAcl = new CfnWebACL(this, "WebAcl", {
      name,
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      associationConfig: {
        requestBody: {
          CLOUDFRONT: { defaultSizeInspectionLimit: BODY_INSPECTION_LIMIT },
        },
      },
      customResponseBodies: CUSTOM_RESPONSE_BODIES,
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: name,
        sampledRequestsEnabled: true,
      },
      dataProtectionConfig: {
        dataProtections: redactedHeaders.map((header) => ({
          action: "SUBSTITUTION",
          field: { fieldType: "SINGLE_HEADER", fieldKeys: [header] },
          excludeRuleMatchDetails: false,
          excludeRateBasedDetails: false,
        })),
      },
      rules,
    });

    this.logGroup = new PlatformLogGroup(this, "Logs", {
      logGroupName: wafLogGroupName(name),
    }).logGroup;

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
      redactedFields: redactedHeaders.map((header) => ({
        singleHeader: { Name: header },
      })),
    });
  }
}
