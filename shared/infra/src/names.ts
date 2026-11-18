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

/** Where GitHub publishes the keys it signs a pipeline's token with, as its discovery document says. */
export const PIPELINE_TOKEN_KEYS_URI = `${PIPELINE_TOKEN_ISSUER}/.well-known/jwks`;

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

/** The release worker's function, and the role it runs as and assumes each deploy role from. */
export const RELEASE_WORKER_NAME = "shared-release-worker";

export const RELEASE_WORKER_LOG_GROUP_NAME = "/flex/shared/release-worker";

/** The queue the pipeline API puts each release on. SQS requires a FIFO queue's name to end so. */
export const RELEASE_QUEUE_NAME = "shared-release.fifo";

/** Where a release goes once the worker has failed it a few times. FIFO, as its queue is. */
export const RELEASE_DEAD_LETTER_QUEUE_NAME = "shared-release-dead-letter.fifo";

/**
 * The function that gives up each release whose message reaches the dead-letter queue, and the
 * role it runs as.
 */
export const RELEASE_DEAD_LETTER_WORKER_NAME =
  "shared-release-dead-letter-worker";

export const RELEASE_DEAD_LETTER_WORKER_LOG_GROUP_NAME =
  "/flex/shared/release-dead-letter-worker";

/** The namespace of the metrics the release's log lines are counted into. */
export const RELEASE_METRIC_NAMESPACE = "flex/shared/release";

/** Every release the pipeline API records, and how each went. */
export const RELEASE_TABLE_NAME = "shared-releases";

/**
 * The release queue's address, which the pipeline API is built with. SQS builds it from the
 * queue's region, its account and its name, so it is known before the queue exists.
 */
export function releaseQueueUrl(account: string): string {
  return `https://sqs.${SHARED_REGION}.amazonaws.com/${account}/${RELEASE_QUEUE_NAME}`;
}

/**
 * The bucket every domain's uploaded code is kept in. Bucket names are global, so it ends in the
 * shared account's ID. 31 characters, within S3's 63.
 */
export function domainCodeBucketName(account: string): string {
  return `shared-domain-code-${account}`;
}

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

/** The origin request policy, which names the viewer headers the pipeline API never sees. */
export const CI_ORIGIN_REQUEST_POLICY_NAME = "shared-management-ci-headers";

/** The origin access control CloudFront signs requests to the pipeline API with. */
export const CI_ORIGIN_ACCESS_CONTROL_NAME = "shared-management-ci";
