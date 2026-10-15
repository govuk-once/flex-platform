export type BearerTokenRejection =
  | { readonly missing: true; readonly reason: "no-header" | "no-token" }
  | { readonly missing: false; readonly reason: "scheme" | "parts" };

const PREFIX = "Bearer ";

// The token in an `authorization` header, which must be exactly `Bearer <token>`. The RFCs allow
// other cases and spacing, but WAF counts requests per token by the header's exact value, so each
// token is accepted in one form only, the one the app sends. Whether it is a token is left to the
// caller.
export function bearerToken(
  authorization: string | undefined,
): { readonly token: string } | BearerTokenRejection {
  if (!authorization) return { missing: true, reason: "no-header" };
  if (authorization === "Bearer") return { missing: true, reason: "no-token" };
  if (authorization.slice(0, PREFIX.length) !== PREFIX) {
    return { missing: false, reason: "scheme" };
  }
  const token = authorization.slice(PREFIX.length);
  if (!token) return { missing: true, reason: "no-token" };
  if (token.indexOf(" ") !== -1) return { missing: false, reason: "parts" };
  return { token };
}
