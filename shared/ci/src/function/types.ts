// The Lambda function URL's event and result, as far as the function reads and writes them, and
// the config baked into it.

// Lambda gives header names in lowercase, and a repeated header's values joined with commas.
export interface FunctionUrlEvent {
  readonly rawPath: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly requestContext: {
    /** Lambda's own ID for the request. */
    readonly requestId: string;
    readonly http: { readonly method: string };
  };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** An environment of the stage, and the domains it hosts. */
export interface CiEnvironment {
  readonly name: string;
  readonly domains: readonly string[];
}

/**
 * A domain and the GitHub repository whose pipeline may release it, by GitHub's IDs, which a
 * repository keeps when it is renamed or transferred.
 */
export interface CiDomain {
  readonly name: string;
  /** As a token's `repository_id` claim has it: digits, in a string. */
  readonly repositoryId: string;
  /** As a token's `repository_owner_id` claim has it. */
  readonly ownerId: string;
}

// Baked into the function when it is built, once per stage.
export interface CiConfig {
  /** Who issues a pipeline's token. */
  readonly issuer: string;
  /** Where the issuer publishes the keys it signs with. */
  readonly keysUri: string;
  /** Who a token must be for: this stage's pipeline API, by its address. */
  readonly audience: string;
  readonly environments: readonly CiEnvironment[];
  /** A domain with no repository yet has no entry, so nothing can release it. */
  readonly domains: readonly CiDomain[];
}
