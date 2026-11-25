// Never keys a domain uses. Each marks one of the caller's IDs, so neither stands in for the other
// and a log refuses both by type. Only readCallerToken gives a string either brand.
declare const PAIRWISE_ID: unique symbol;

declare const PUSH_ID: unique symbol;

/** The caller's ID for this service. A string wherever one is taken; never logged. */
export type PairwiseId = string & { readonly [PAIRWISE_ID]: true };

/** The ID the caller's notifications are sent under. A string wherever one is taken; never logged. */
export type PushId = string & { readonly [PUSH_ID]: true };
