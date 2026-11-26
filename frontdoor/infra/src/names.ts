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

/** A kind of key's rotation role, in the frontdoor account. */
export function keyRotationRoleName(environment: string, kind: string): string {
  return `frontdoor-${environment}-${kind}-key-rotation`;
}

/** The alias of the key that wraps the caller token's signing keys. */
export function signingKeyAliasName(environment: string): string {
  return `alias/frontdoor-${environment}-caller-token`;
}

/**
 * The secret the edge derives each caller's push ID with. Secrets Manager adds six characters of
 * its own to the ARN, so a policy names it by a pattern.
 */
export function pushIdSecretName(environment: string): string {
  return `frontdoor-${environment}-push-id-secret`;
}

/**
 * A kind of key's private keys, such as the caller token's, which its readers read. Key rotation
 * writes them; no stack does.
 */
export function privateKeysTableName(
  environment: string,
  kind: string,
): string {
  return `frontdoor-${environment}-${kind}-private-keys`;
}

/**
 * A kind of key's public keys, and key rotation's own record of them, which its readers read. Key
 * rotation writes them; no stack does.
 */
export function publicKeysTableName(environment: string, kind: string): string {
  return `frontdoor-${environment}-${kind}-public-keys`;
}

/** A kind of key's rotation function, and the schedule that runs it. */
export function keyRotationFunctionName(
  environment: string,
  kind: string,
): string {
  return `frontdoor-${environment}-${kind}-key-rotation`;
}

/** The role EventBridge Scheduler runs a kind of key's rotation as, in the frontdoor account. */
export function keyRotationScheduleRoleName(
  environment: string,
  kind: string,
): string {
  return `frontdoor-${environment}-${kind}-key-rotation-schedule`;
}

/** The alarm on a kind of key's failed rotation runs. */
export function keyRotationAlarmName(
  environment: string,
  kind: string,
): string {
  return `frontdoor-${environment}-${kind}-key-rotation-failed`;
}

/** A kind of key's rotation log group. */
export function keyRotationLogGroupName(
  environment: string,
  kind: string,
): string {
  return `/flex/frontdoor/${environment}/${kind}-key-rotation`;
}
