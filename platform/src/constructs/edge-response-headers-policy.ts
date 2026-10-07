import { Duration } from "aws-cdk-lib";
import {
  HeadersFrameOption,
  HeadersReferrerPolicy,
  ResponseHeadersPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { Construct } from "constructs";

export interface EdgeResponseHeadersPolicyProps {
  readonly policyName: string;
  readonly contentSecurityPolicy: string;
}

/**
 * Every header overrides the origin's, so a domain cannot weaken them; `no-store` keeps API
 * responses, which may be personal, out of every cache between the edge and the caller.
 */
export class EdgeResponseHeadersPolicy extends Construct {
  public readonly policy: ResponseHeadersPolicy;

  constructor(
    scope: Construct,
    id: string,
    props: EdgeResponseHeadersPolicyProps,
  ) {
    super(scope, id);

    this.policy = new ResponseHeadersPolicy(this, "Policy", {
      responseHeadersPolicyName: props.policyName,
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentSecurityPolicy: {
          contentSecurityPolicy: props.contentSecurityPolicy,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: "X-Permitted-Cross-Domain-Policies",
            value: "none",
            override: true,
          },
          { header: "Cache-Control", value: "no-store", override: true },
        ],
      },
    });
  }
}
