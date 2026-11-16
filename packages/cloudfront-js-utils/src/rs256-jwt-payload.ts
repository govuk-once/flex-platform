import { isCanonicalBase64url } from "./is-canonical-base64url.ts";
import { jwtSegmentObject } from "./jwt-segment-object.ts";

// The part of an RS256 JWT's shape a token lacks. Each is a fixed code, safe to log.
export type JwtShapeFault =
  "length" | "segments" | "header" | "algorithm" | "payload" | "signature";

// The payload of a token shaped like an RS256 JWT, or the first part of that shape it lacks: at
// most `maxLength` characters, in three segments, each canonical base64url, the header and the
// payload JSON objects, and `alg` RS256. Nothing here is verification: the payload is whatever
// the token's sender wrote, and a token that passes may still be forged.
export function rs256JwtPayload(
  token: string,
  maxLength: number,
): Record<string, unknown> | JwtShapeFault {
  if (token.length > maxLength) return "length";

  const segments = token.split(".");
  if (segments.length !== 3) return "segments";

  const header = jwtSegmentObject(segments[0]);
  if (!header) return "header";
  // An allowlist, not a refusal of "none".
  if (header.alg !== "RS256") return "algorithm";

  const payload = jwtSegmentObject(segments[1]);
  if (!payload) return "payload";

  const signature = segments[2];
  if (signature === undefined || !isCanonicalBase64url(signature)) {
    return "signature";
  }
  return payload;
}
