// Names derived from config. The app and the constructs build them with these same functions, so
// a consumer that needs one never reads it back from a deployed stack.
//
//   domain-{environment}-{name}                 a domain's function, its role and its API
//   /flex/domain/{environment}/{name}/{thing}   a domain's log groups
//   {name}.{zone}                               the host a domain's API answers at
//
// Where AWS sets a name, such as API Gateway's execution logs, the name follows it.

// Lambda's and IAM's limit on a function's and a role's name.
export const RESOURCE_NAME_LENGTH = 64;

export interface EnvironmentNameOptions {
  readonly environment: string;
}

export interface HostNameOptions {
  readonly zoneName: string;
}

export function domainResourceName(
  domainName: string,
  { environment }: EnvironmentNameOptions,
): string {
  return `domain-${environment}-${domainName}`;
}

export function functionLogGroupName(
  domainName: string,
  { environment }: EnvironmentNameOptions,
): string {
  return `/flex/domain/${environment}/${domainName}/function`;
}

export function apiAccessLogGroupName(
  domainName: string,
  { environment }: EnvironmentNameOptions,
): string {
  return `/flex/domain/${environment}/${domainName}/api-access`;
}

/** Every log group a domain names itself in an environment, as an IAM resource pattern. */
export function domainLogGroupPattern({
  environment,
}: EnvironmentNameOptions): string {
  return `/flex/domain/${environment}/*`;
}

/** API Gateway writes a stage's execution logs to this name, and creates it if it's missing. */
export function apiExecutionLogGroupName(
  restApiId: string,
  stageName: string,
): string {
  return `API-Gateway-Execution-Logs_${restApiId}/${stageName}`;
}

/** Every API's execution logs in an account, as an IAM resource pattern. */
export const API_EXECUTION_LOG_GROUP_PATTERN = "API-Gateway-Execution-Logs_*";

/** The host a domain's API answers at, and the Frontdoor sends the domain's requests to. */
export function domainHostName(
  domainName: string,
  { zoneName }: HostNameOptions,
): string {
  return `${domainName}.${zoneName}`;
}
