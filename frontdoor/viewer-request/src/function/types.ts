import type { TrustedIssuer } from "@repo/frontdoor-shared";

// Baked into the function when it is built, once per environment.
export interface ViewerRequestConfig {
  readonly issuers: readonly TrustedIssuer[];
}
