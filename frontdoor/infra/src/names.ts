// Names derived from config. The app and the edge build them with these same functions, so a
// consumer that needs one never reads it back from the deployed stack.

/** The API layer's name, which the distribution forwards to until Lambda@Edge routes per domain. */
export function originDomainName(domainName: string): string {
  return `api.${domainName}`;
}

export function webAclName(environment: string): string {
  return `frontdoor-${environment}`;
}

/** WAF only accepts a log group whose name starts with `aws-waf-logs-`. */
export function wafLogGroupName(environment: string): string {
  return `aws-waf-logs-${webAclName(environment)}`;
}

/** The log group CloudFront's access logs are delivered to, and the delivery's own names. */
export function accessLogsName(environment: string): string {
  return `frontdoor-${environment}-access-logs`;
}
