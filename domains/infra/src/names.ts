// Names derived from config. The app and the constructs build them with these same functions, so a
// consumer that needs one never reads it back from the deployed stack.
//
// Every name follows one template, and a domain's stack name too:
//
//   domain-{environment}-{domain}    a domain's function and stack, its API with -api, its API's
//                                    alarms with -api-{alarm}, and its roles with -execution and
//                                    -deploy
//
// A domain account's stack is domainaccount-{environment}-{account}, so it is never a domain's.
//
// A log group's or parameter's name is a path instead: /flex/domain/{environment}/{thing}, with
// {domain}/ before {thing} for one of a domain's. A domain's API's metrics are in the namespace
// flex/domain/{environment}/{domain}/api. A domain answers at {domain}.{zone}. Where AWS sets a name, the name follows it: API Gateway's execution
// logs.

/** Domains are built in the region the edge signs requests for. */
export const DOMAIN_REGION = "eu-west-2";

/** IAM's limit on a role's name. */
export const ROLE_NAME_LENGTH = 64;

/** The alias each release moves, and the only one a domain's API invokes. */
export const LIVE_ALIAS = "live";

export function domainHost(domain: string, zoneName: string): string {
  return `${domain}.${zoneName}`;
}

// The function is created outside CloudFormation, from the team's code, so everything else finds
// it by this name rather than by reference.
export function domainFunctionName(
  environment: string,
  domain: string,
): string {
  return `domain-${environment}-${domain}`;
}

export function apiName(environment: string, domain: string): string {
  return `${domainFunctionName(environment, domain)}-api`;
}

export function apiAlarmName(
  environment: string,
  domain: string,
  alarm: string,
): string {
  return `${apiName(environment, domain)}-${alarm}`;
}

// A metric filter takes its dimensions only from the fields of the line it matches, so a domain's
// API's metrics are told apart by namespace.
export function apiMetricNamespace(
  environment: string,
  domain: string,
): string {
  return `flex/domain/${environment}/${domain}/api`;
}

// Of the names Lambda and IAM limit to 64 characters, the longest a domain has, so the one config
// checks.
export function executionRoleName(environment: string, domain: string): string {
  return `${domainFunctionName(environment, domain)}-execution`;
}

export function deployRoleName(environment: string, domain: string): string {
  return `${domainFunctionName(environment, domain)}-deploy`;
}

export function functionLogGroupName(
  environment: string,
  domain: string,
): string {
  return `/flex/domain/${environment}/${domain}/function`;
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
