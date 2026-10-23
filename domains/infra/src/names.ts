// Names derived from config, so nothing reads one back from a deployed stack. Each follows the
// platform's template, domain-{environment}-{domain}.

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
