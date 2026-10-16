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
// /aws/cloudfront/function/ before the function's name.

export function webAclName(environment: string): string {
  return `frontdoor-${environment}-web-acl`;
}

/** WAF only accepts a log group whose name starts with `aws-waf-logs-`. */
export function wafLogGroupName(environment: string): string {
  return `aws-waf-logs-${webAclName(environment)}`;
}

/** The CloudFront Function's name, which also names the log group CloudFront writes it to. */
export function viewerRequestFunctionName(environment: string): string {
  return `frontdoor-${environment}-viewer-request`;
}

/** CloudFront writes a function's logs here, in us-east-1, and creates the group if it's missing. */
export function viewerRequestLogGroupName(environment: string): string {
  return `/aws/cloudfront/function/${viewerRequestFunctionName(environment)}`;
}

/** The log group CloudFront's access logs are delivered to, and the delivery's own names. */
export function accessLogsName(environment: string): string {
  return `frontdoor-${environment}-access-logs`;
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
