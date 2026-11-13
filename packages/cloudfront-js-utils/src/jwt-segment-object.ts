import { isCanonicalBase64url } from "./is-canonical-base64url.ts";

// The JSON object a JWT's header or payload segment holds, or undefined when the segment isn't
// canonical base64url, isn't JSON, or holds anything but an object. Nothing here is verification:
// the object is whatever the token's sender wrote.
//
// A JWT segment is base64url without padding. Buffer is given standard base64, so this works
// whichever encodings a runtime's Buffer supports.
export function jwtSegmentObject(
  segment: string | undefined,
): Record<string, unknown> | undefined {
  if (segment === undefined || !isCanonicalBase64url(segment)) return undefined;
  const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "===".slice(0, (4 - (base64.length % 4)) % 4);
  try {
    const value: unknown = JSON.parse(
      Buffer.from(padded, "base64").toString("utf8"),
    );
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Not JSON: refused below.
  }
  return undefined;
}
