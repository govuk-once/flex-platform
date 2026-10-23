// Names derived from config, so nothing reads one back from a deployed stack. Grouped by template:
//
//   domain-{environment}-{domain}     a domain's function
//   domain-{environment}-{thing}      what every domain in an environment shares
//   /flex/domain/{environment}/...    log groups and parameters the platform creates
//   /flex/network/{environment}/...   parameters written by hand, for the VPC that isn't ours
//
// Names AWS sets come last.

export const DOMAIN_REGION = "eu-west-2";

export const LIVE_ALIAS = "live";

export const FUNCTION_NAME_LENGTH = 64;

// The function is created outside CloudFormation, from the team's code, so everything else finds
// it by this name rather than by reference.
export function domainFunctionName(
  environment: string,
  domain: string,
): string {
  return `domain-${environment}-${domain}`;
}

export function executionRoleName(environment: string): string {
  return `domain-${environment}-execution`;
}

export function integrationRoleName(environment: string): string {
  return `domain-${environment}-integration`;
}

export function functionLogGroupName(environment: string): string {
  return `/flex/domain/${environment}/function`;
}

export function apiAccessLogGroupName(
  environment: string,
  domain: string,
): string {
  return `/flex/domain/${environment}/${domain}/api-access`;
}

// ACM generates the certificate's ARN, so each domain's stack reads it from here.
export function certificateParameterName(environment: string): string {
  return `/flex/domain/${environment}/certificate-arn`;
}

export function securityGroupParameterName(environment: string): string {
  return `/flex/domain/${environment}/security-group-id`;
}

export function vpcIdParameterName(environment: string): string {
  return `/flex/network/${environment}/vpc-id`;
}

export function lambdaEndpointSecurityGroupParameterName(
  environment: string,
): string {
  return `/flex/network/${environment}/lambda-endpoint-security-group-id`;
}

export function apiExecutionLogGroupName(
  restApiId: string,
  stageName: string,
): string {
  return `API-Gateway-Execution-Logs_${restApiId}/${stageName}`;
}
