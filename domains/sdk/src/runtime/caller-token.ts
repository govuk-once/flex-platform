// The caller, read from the token the Frontdoor signs and sends as `x-flex-secure`. It is read and
// never verified: API Gateway admits only the requests the Frontdoor signed, and a gateway verifies
// the token on every call the domain makes with it. So this reading is not an authentication
// control, and the token is passed on unchanged.

import { jwtSegmentObject } from "@repo/cloudfront-js-utils/jwt-segment-object";

import type { PairwiseId, PushId } from "../caller.ts";
import type { Caller } from "../handler.ts";

export interface CallerToken {
  readonly caller: Caller;
  readonly token: string;
}

function isPairwiseId(value: unknown): value is PairwiseId {
  return typeof value === "string" && value !== "";
}

function isPushId(value: unknown): value is PushId {
  return typeof value === "string" && value !== "";
}

/** The caller and their token, or undefined when the token is missing or unreadable. */
export function readCallerToken(
  token: string | null | undefined,
): CallerToken | undefined {
  const [, payload, signature, ...rest] = token?.split(".") ?? [];

  if (token == null || signature === undefined || rest.length > 0) {
    return undefined;
  }

  const { pairwiseId, pushId } = jwtSegmentObject(payload) ?? {};

  if (!isPairwiseId(pairwiseId) || !isPushId(pushId)) return undefined;

  return { caller: { pairwiseId, pushId }, token };
}
