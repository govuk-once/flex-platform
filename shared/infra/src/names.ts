import { crossRegionParameterName } from "@repo/infra-constructs";

// Names in the shared account. A stage has one shared account, and deploys only to its own
// accounts, so a name here holds neither a stage nor an environment:
//
//   shared-{thing}               a resource, such as the test user pool and its client,
//                                shared-test-users
//   shared-management-{thing}    a part of the management distribution
//
// A log group's name is a path instead: /flex/shared/{thing}. Where AWS requires a prefix, the
// constructs in @repo/infra-constructs that create the log group add it.

/** The shared account's stacks are in the platform's home region. */
export const SHARED_REGION = "eu-west-2";

/** Where CloudFront takes a web ACL and a certificate from, so where the distribution is built. */
export const MANAGEMENT_REGION = "us-east-1";

export const TEST_USER_POOL_NAME = "shared-test-users";

/** Who issues a pipeline's token: GitHub Actions. */
export const PIPELINE_TOKEN_ISSUER =
  "https://token.actions.githubusercontent.com";

/**
 * Who a pipeline's token must be for: the pipeline API's own address, at the apex of the shared
 * account's zone. A job asks GitHub for a token with this audience.
 */
export function ciAudience(zoneName: string): string {
  return `https://${zoneName}/ci`;
}

/** The pipeline API's function, and the role it runs as. */
export const CI_FUNCTION_NAME = "shared-ci";

export const CI_LOG_GROUP_NAME = "/flex/shared/ci";

/**
 * Where the distribution's stack reads the host of the pipeline API's function URL, which AWS
 * generates in the function's region.
 */
export const CI_ORIGIN_HOST_PARAMETER = crossRegionParameterName(
  "shared",
  "ci-origin-host",
);

/** The log group of the function that writes the parameter above. */
export const CROSS_REGION_WRITER_LOG_GROUP_NAME =
  "/flex/shared/cross-region-writer";

/** The CloudFront Function's name, which also names the log group CloudFront writes it to. */
export const MANAGEMENT_VIEWER_REQUEST_FUNCTION_NAME =
  "shared-management-viewer-request";

export const MANAGEMENT_WEB_ACL_NAME = "shared-management-web-acl";

/** The access log delivery's names: its source, its destination and the policy that lets it write. */
export const MANAGEMENT_ACCESS_LOGS_NAME = "shared-management-access-logs";

export const MANAGEMENT_RESPONSE_HEADERS_POLICY_NAME =
  "shared-management-response-headers";

/** The origin request policy, which names the viewer headers the pipeline API sees. */
export const CI_ORIGIN_REQUEST_POLICY_NAME = "shared-management-ci-headers";

/** The origin access control CloudFront signs requests to the pipeline API with. */
export const CI_ORIGIN_ACCESS_CONTROL_NAME = "shared-management-ci";
