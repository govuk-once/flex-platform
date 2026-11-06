import { ResourceCheck } from "./resource-check.ts";

export const API_IAM_RULE = "Flex-ApiIam";

/**
 * Fails synth on any API Gateway method that doesn't use IAM authorisation. The Frontdoor signs
 * every request it forwards with SigV4, and IAM authorisation makes API Gateway check that
 * signature, so the API's resource policy can admit the Frontdoor's edge role alone. cdk-nag only
 * requires some authorisation, and a method with a Cognito or custom authoriser never checks the
 * signature, so a caller could reach it without passing through the Frontdoor.
 */
export class ApiIamCheck extends ResourceCheck {
  constructor() {
    super({
      name: API_IAM_RULE,
      description:
        "An API Gateway method must use IAM authorisation, so API Gateway verifies each request's SigV4 signature and holds the signer to the API's resource policy.",
      fix: "Set the method's authorisation type to AWS_IAM. ProxyApi in @repo/domain-infra does, for every method of a domain's API.",
      type: "AWS::ApiGateway::Method",
      faults: (resource) =>
        resource.Properties?.AuthorizationType === "AWS_IAM"
          ? []
          : ["Properties/AuthorizationType"],
    });
  }
}
