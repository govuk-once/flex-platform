// A Cognito user pool whose access tokens are accepted, as its `iss` claim, and the app clients
// within it, as their `client_id` claim. A client belongs to one pool, so each is listed with its
// own. The infra builds the list from an environment's config, and each function's build bakes it
// in.
export interface TrustedIssuer {
  readonly issuer: string;
  readonly clientIds: readonly string[];
}
