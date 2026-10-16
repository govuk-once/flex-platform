import { Names } from "aws-cdk-lib";
import {
  CfnOriginRequestPolicy,
  type IOriginRequestPolicy,
  OriginRequestPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { Construct } from "constructs";

/**
 * The only viewer headers the origin sees, and so the only ones Lambda@Edge's origin request event
 * holds. No cookies, and none of CloudFront's viewer IP and location headers.
 *
 * It also names every header Lambda@Edge sets, but for `host` and AWS's `x-amz-*` signing
 * headers: CloudFront forwards a header a function adds only some of the time unless the policy
 * names it. `x-flex-secure` is here for that reason alone; the CloudFront Function removes a
 * caller's copy.
 */
export const FORWARDED_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "x-correlation-id",
  "x-flex-secure",
] as const;

/**
 * Forwards `FORWARDED_HEADERS` and every query string. It's built at the CloudFormation level
 * because CDK's header allowlist refuses `authorization`, which CloudFront accepts
 * (aws-cdk#28883). Caching stays off in the cache policy, which this doesn't touch.
 */
export class EdgeOriginRequestPolicy extends Construct {
  public readonly policy: IOriginRequestPolicy;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const policy = new CfnOriginRequestPolicy(this, "Resource", {
      originRequestPolicyConfig: {
        name: Names.uniqueId(this),
        headersConfig: {
          headerBehavior: "whitelist",
          headers: [...FORWARDED_HEADERS],
        },
        queryStringsConfig: { queryStringBehavior: "all" },
        cookiesConfig: { cookieBehavior: "none" },
      },
    });
    this.policy = OriginRequestPolicy.fromOriginRequestPolicyId(
      this,
      "Policy",
      policy.ref,
    );
  }
}
