// The caller, read from the one header the Frontdoor sets for it. The token is decoded and never
// verified: the gateway verifies what a domain asserts about its caller, so the platform is
// protected whatever a domain does, and this reading is not an authentication control. API
// Gateway's own check keeps unsigned requests out, so a request without a readable token is a
// consistency failure, answered 401 with the Frontdoor's own body.
//
// The token's claims are provisional: the Frontdoor sends a placeholder today, and the single
// token the platform has decided on is not yet sent. `pairwiseId` is the one claim agreed.

import type { SecureContext } from "@govuk-once/flex-gateway-client/caller";
import type { SecureValue } from "@repo/gateway-core";
import { isRecord } from "@repo/utils/is-record";
import { isScalar } from "@repo/utils/is-scalar";

export const CALLER_HEADER = "x-flex-secure";

export interface Caller {
  /** The user's id, as the Frontdoor pairs it for this domain. */
  readonly pairwiseId: string;
}

export interface CallerIdentity {
  /** What a handler sees. */
  readonly caller: Caller;
  /** What the gateway client sends with each call made for the caller. */
  readonly secure: SecureContext;
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf-8"));
  } catch {
    return undefined;
  }
}

// The claims the gateway compares with its secure bindings: the token's scalar claims, as the
// Frontdoor wrote them, and its signature as the proof they were. Nested claims are not values a
// binding can name, and are left out.
function secureValues(
  claims: Readonly<Record<string, unknown>>,
): Readonly<Record<string, SecureValue>> {
  const values: Record<string, SecureValue> = {};
  for (const [name, value] of Object.entries(claims)) {
    if (value === null || isScalar(value)) values[name] = value;
  }
  return values;
}

/** The caller a request's headers (names in lower case) carry, or undefined when they carry none. */
export function readCaller(
  headers: Readonly<Record<string, string>>,
): CallerIdentity | undefined {
  const token = headers[CALLER_HEADER];
  if (token === undefined) return undefined;
  const segments = token.split(".");
  if (segments.length !== 3) return undefined;
  const [, payload, signature] = segments;
  if (payload === undefined || signature === undefined || signature === "") {
    return undefined;
  }
  const claims = decodeSegment(payload);
  if (!isRecord(claims)) return undefined;
  const pairwiseId = claims["pairwiseId"];
  if (typeof pairwiseId !== "string" || pairwiseId === "") return undefined;
  return {
    caller: { pairwiseId },
    secure: { values: secureValues(claims), signature },
  };
}
