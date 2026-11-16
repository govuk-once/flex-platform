import { ResourceCheck } from "./resource-check.ts";

export const FUNCTION_URL_IAM_RULE = "Flex-FunctionUrlIam";

/**
 * Fails synth on any Lambda function URL that doesn't use IAM authorisation. A function URL is a
 * public address, and with any other setting Lambda runs the function for whoever calls it. With
 * IAM, Lambda checks each request's SigV4 signature and holds the signer to the function's
 * policy, so a URL behind CloudFront can admit CloudFront alone, and a request sent straight to
 * it is refused before the function runs. cdk-nag has no rule for it.
 */
export class FunctionUrlIamCheck extends ResourceCheck {
  constructor() {
    super({
      name: FUNCTION_URL_IAM_RULE,
      description:
        "A Lambda function URL must use IAM authorisation, so Lambda verifies each request's SigV4 signature and holds the signer to the function's policy.",
      fix: "Set the URL's authorisation type to AWS_IAM, and admit its one caller in the function's policy. CiFunction in @repo/shared-infra does, for CloudFront.",
      type: "AWS::Lambda::Url",
      faults: (resource) =>
        resource.Properties?.AuthType === "AWS_IAM"
          ? []
          : ["Properties/AuthType"],
    });
  }
}
