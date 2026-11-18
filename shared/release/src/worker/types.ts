// What a release is for, as the platform's config names it.

/**
 * One domain in one environment, and everything a release of it names. Each value is a plain
 * string, derived from the platform's config when the worker is built.
 */
export interface ReleaseTarget {
  readonly environment: string;
  readonly domain: string;
  /** The role the worker assumes in the domain account to release the function, by ARN. */
  readonly deployRoleArn: string;
  /** The domain's function, `domain-<environment>-<name>`. */
  readonly functionName: string;
  /** The role the function runs as, by ARN. */
  readonly executionRoleArn: string;
  /** The log group the function writes to, which its role may write to and no other. */
  readonly logGroupName: string;
  /** The parameters, in the domain account, holding the subnets and the security group. */
  readonly subnetIdsParameter: string;
  readonly securityGroupIdParameter: string;
}
