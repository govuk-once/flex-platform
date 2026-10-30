// Names derived from config. The app and the constructs build them with these same functions, so a
// consumer that needs one never reads it back from the deployed stack.
//
// Every name follows one template, and stack names too:
//
//   domain-{environment}-{domain}    a domain's function
//   domain-{environment}-{thing}     what every domain in the environment shares
//
// A log group's or parameter's name is a path instead: /flex/domain/{environment}/{thing}. Where AWS
// sets a name, the name follows it: API Gateway's execution logs.

/** Domains are built in the region the edge signs requests for. */
export const DOMAIN_REGION = "eu-west-2";

/** Lambda's limit on a function's name. */
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

export function deployRoleName(environment: string): string {
  return `domain-${environment}-deploy`;
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

export function certificateParameterName(environment: string): string {
  return `/flex/domain/${environment}/certificate-arn`;
}

export function apiExecutionLogGroupName(
  restApiId: string,
  stageName: string,
): string {
  return `API-Gateway-Execution-Logs_${restApiId}/${stageName}`;
}
