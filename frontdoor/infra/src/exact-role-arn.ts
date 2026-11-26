/**
 * A role's ARN that names one role. A policy matches a principal's ARN as a pattern, so one that
 * holds a wildcard would let in every role it matches.
 */
export function exactRoleArn(roleArn: string, does: string): string {
  if (/[*?]/.test(roleArn)) {
    throw new Error(
      `The role that ${does} is named exactly, not by a pattern: ${roleArn}`,
    );
  }
  return roleArn;
}
