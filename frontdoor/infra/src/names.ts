// Names derived from config. The app and the edge build them with these same functions, so a
// consumer that needs one never reads it back from the deployed stack.
//
// Every name follows one template, and stack names too:
//
//   frontdoor-{environment}-{thing}            such as frontdoor-production-origin-request
//   frontdoor-{environment}-{thing}-{region}   for one of a set, one per region
//   frontdoor-{environment}                    the environment's main stack alone
//
// A log group's name is a path instead: /flex/frontdoor/{environment}/{thing}. Where AWS requires
// a prefix, the name above follows it: WAF's aws-waf-logs-, and CloudFront's
// /aws/cloudfront/function/ before the function's name. The constructs in @repo/infra-constructs
// that create those two log groups derive their names.

export function webAclName(environment: string): string {
  return `frontdoor-${environment}-web-acl`;
}

/** The CloudFront Function's name, which also names the log group CloudFront writes it to. */
export function viewerRequestFunctionName(environment: string): string {
  return `frontdoor-${environment}-viewer-request`;
}

/**
 * The access log delivery's names: its source, its destination and the account's resource policy
 * that lets it write. CloudFormation names the log group the logs are delivered to.
 */
export function accessLogsName(environment: string): string {
  return `frontdoor-${environment}-access-logs`;
}

/** The origin request policy, which names the viewer headers the origin sees. */
export function originRequestPolicyName(environment: string): string {
  return `frontdoor-${environment}-forwarded-headers`;
}

/** The response headers policy, which sets the security headers on every response. */
export function responseHeadersPolicyName(environment: string): string {
  return `frontdoor-${environment}-response-headers`;
}

/** The Lambda@Edge function's name. */
export function originRequestFunctionName(environment: string): string {
  return `frontdoor-${environment}-origin-request`;
}

/** The Lambda@Edge function's role. Domain APIs name it to let the edge call them. */
export function edgeRoleName(environment: string): string {
  return `frontdoor-${environment}-edge`;
}

/**
 * Lambda@Edge writes a function's logs in the region each copy ran in, to this name in every
 * region. Only `ORIGIN_REQUEST_LOG_REGION`'s group exists, and only it accepts the role's writes.
 */
export function originRequestLogGroupName(environment: string): string {
  return `/flex/frontdoor/${environment}/origin-request`;
}

/** The policy that lets the function's role write to its log group in one region. */
export function originRequestLogsPolicyName(
  environment: string,
  region: string,
): string {
  return `frontdoor-${environment}-origin-request-logs-${region}`;
}

/** The one region whose copy of the origin request function's log group exists. */
export const ORIGIN_REQUEST_LOG_REGION = "eu-west-2";

/**
 * The bucket, in the frontdoor account, that every gateway reads the caller token's public keys
 * from. Bucket names are global, so it ends in the account's ID. At most 60 characters, within
 * S3's 63, whatever the environment's name.
 */
export function callerTokenKeysBucketName(
  environment: string,
  account: string,
): string {
  return `frontdoor-${environment}-keys-${account}`;
}

/** The public keys' object in that bucket, a JWK set. Key rotation writes it; no stack does. */
export const CALLER_TOKEN_KEYS_OBJECT = "caller-token-keys.json";

/** Key rotation's own role, in the frontdoor account. */
export function keyRotationRoleName(environment: string): string {
  return `frontdoor-${environment}-key-rotation`;
}

/** The alias of the key that wraps the caller token's signing keys. */
export function signingKeyAliasName(environment: string): string {
  return `alias/frontdoor-${environment}-caller-token`;
}

/** Where the edge reads the keys it signs with. Key rotation writes it. */
export function signingKeyParameterName(environment: string): string {
  return `/flex/frontdoor/${environment}/caller-token-signing-key`;
}

/** Where key rotation keeps its state. Key rotation writes it. */
export function keyRotationStateParameterName(environment: string): string {
  return `/flex/frontdoor/${environment}/caller-token-key-state`;
}

/** Key rotation's function, and the schedule that runs it. */
export function keyRotationFunctionName(environment: string): string {
  return `frontdoor-${environment}-key-rotation`;
}

/** The role EventBridge Scheduler runs key rotation's schedule as, in the frontdoor account. */
export function keyRotationScheduleRoleName(environment: string): string {
  return `frontdoor-${environment}-key-rotation-schedule`;
}

/** The alarm on key rotation's failed runs. */
export function keyRotationAlarmName(environment: string): string {
  return `frontdoor-${environment}-key-rotation-failed`;
}

/** Key rotation's log group. */
export function keyRotationLogGroupName(environment: string): string {
  return `/flex/frontdoor/${environment}/key-rotation`;
}
