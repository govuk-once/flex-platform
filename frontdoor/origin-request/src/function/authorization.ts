import type { BearerTokenRejection } from "@repo/frontdoor-shared";
import { bearerToken } from "@repo/frontdoor-shared";

import type { CloudFrontHeaders } from "./types.ts";

export type AuthorizationRejection =
  | BearerTokenRejection
  | { readonly missing: false; readonly reason: "repeated" };

// The bearer token in the request's one `authorization` header, read by the CloudFront Function's
// rules. The function refused any other shape already. This is read again rather than trusted,
// because it is what the signature check runs on.
export function authorizationToken(
  headers: CloudFrontHeaders,
): { readonly token: string } | AuthorizationRejection {
  const values = headers.authorization ?? [];
  if (values.length > 1) return { missing: false, reason: "repeated" };
  return bearerToken(values[0]?.value);
}
