import { constants } from "node:os";

// An error's name and code are writable strings, so a library can put anything in them and the
// runtime would log it. Only values from these fixed sets reach a diagnostic message.
const ERROR_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "DOMException",
  "AbortError",
  "TimeoutError",
]);

// A code reaches the log exactly as written, so it must come from a set this driver vouches
// for; matching is by membership, never by prefix or shape, because a payload can be spelled
// like a code. The list is deliberately incomplete: a code missing from it costs the detail in
// the message and nothing else, since the failure is still reported as UPSTREAM_ERROR. Add a
// code when a real diagnosis needed it, not to make the list look complete.
//
// Platform errno names come from the runtime rather than a hand-kept list; the rest are the
// resolver, undici and TLS codes fetch surfaces for a failed connection.
const SAFE_ERROR_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(constants.errno),
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EAI_NODATA",
  "EAI_NONAME",
  // https://github.com/nodejs/undici/blob/main/lib/core/errors.js
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "UND_ERR_DESTROYED",
  "UND_ERR_CLOSED",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_RES_EXCEEDED_MAX_SIZE",
  // https://nodejs.org/api/tls.html#x509-certificate-error-codes
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

function allowed(value: unknown, set: ReadonlySet<string>): string | undefined {
  return typeof value === "string" && set.has(value) ? value : undefined;
}

// "TypeError (ECONNREFUSED)" for a known failure; "Error" for anything unrecognised.
export function describeTransportError(err: unknown): string {
  if (!(err instanceof Error)) return "Error";
  const name = allowed(err.name, ERROR_NAMES) ?? "Error";
  const cause = err.cause;
  const code =
    cause !== null && typeof cause === "object" && "code" in cause
      ? allowed(cause.code, SAFE_ERROR_CODES)
      : undefined;
  return code === undefined ? name : `${name} (${code})`;
}
