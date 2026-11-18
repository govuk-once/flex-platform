// The config baked into the release worker, and the SQS event it is given.

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

/**
 * The longest one attempt at a release may take, which is the worker's timeout, and Lambda's
 * longest. A first release creates a function in a VPC, which Lambda can take minutes to make
 * ready. The attempt's waits share what is left of it.
 */
export const RELEASE_TIMEOUT_SECONDS = 15 * 60;

// Baked into the worker when it is built, once per stage.
export interface ReleaseConfig {
  /** The bucket every domain's bundles are kept in. */
  readonly bucket: string;
  /** The region the bucket, the worker and every domain's function are in. */
  readonly region: string;
  /** The release table, by name, in the same region. */
  readonly table: string;
  readonly targets: readonly ReleaseTarget[];
}

/** The SQS event, as far as the worker reads it. The queue gives it one message at a time. */
export interface SqsEvent {
  readonly Records: readonly {
    readonly messageId: string;
    readonly body: string;
  }[];
}

/** Lambda's context, as far as the worker reads it. */
export interface LambdaContext {
  getRemainingTimeInMillis(): number;
}

/** The messages to give back to the queue, so it delivers them again. */
export interface SqsBatchResponse {
  readonly batchItemFailures: readonly { readonly itemIdentifier: string }[];
}
