import { Template } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";

import { stackIn } from "../../test/cloudfront.ts";
import {
  ApiResponseHeadersPolicy,
  CONTENT_SECURITY_POLICY,
} from "./response-headers-policy.ts";

describe("ApiResponseHeadersPolicy", () => {
  it("sets every security header over the origin's, keeps responses out of caches, and removes the headers it is given", () => {
    const { stack } = stackIn("us-east-1");
    new ApiResponseHeadersPolicy(stack, "ResponseHeaders", {
      name: "example-response-headers",
      removeHeaders: ["x-amzn-trace-id"],
    });

    Template.fromStack(stack).hasResourceProperties(
      "AWS::CloudFront::ResponseHeadersPolicy",
      {
        ResponseHeadersPolicyConfig: {
          Name: "example-response-headers",
          SecurityHeadersConfig: {
            ContentTypeOptions: { Override: true },
            FrameOptions: { FrameOption: "DENY", Override: true },
            ReferrerPolicy: { ReferrerPolicy: "no-referrer", Override: true },
            StrictTransportSecurity: {
              AccessControlMaxAgeSec: 31536000,
              IncludeSubdomains: true,
              Override: true,
            },
            ContentSecurityPolicy: {
              ContentSecurityPolicy: CONTENT_SECURITY_POLICY,
              Override: true,
            },
          },
          CustomHeadersConfig: {
            Items: [
              {
                Header: "X-Permitted-Cross-Domain-Policies",
                Value: "none",
                Override: true,
              },
              { Header: "Cache-Control", Value: "no-store", Override: true },
              {
                Header: "Cross-Origin-Resource-Policy",
                Value: "same-origin",
                Override: true,
              },
            ],
          },
          RemoveHeadersConfig: { Items: [{ Header: "x-amzn-trace-id" }] },
        },
      },
    );
  });
});
