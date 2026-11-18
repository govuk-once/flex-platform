// What a pipeline says of the bundle it is about to upload.

import type { FunctionUrlEvent } from "./types.ts";

/**
 * The most a bundle may weigh: what Lambda allows a function's code to unzip to, which no zip of
 * it usefully exceeds.
 */
export const MAX_BUNDLE_BYTES = 250 * 1024 * 1024;

// The request's body is two short fields. Far longer is not one.
const MAX_BODY_LENGTH = 1024;

// A SHA-256 in hex, in lowercase, so one bundle has one key.
const SHA256_HEX = /^[0-9a-f]{64}$/;

const FIELDS = new Set(["sha256", "size"]);

export interface Bundle {
  /** The zip's SHA-256, in lowercase hex. */
  readonly sha256: string;
  /** The zip's length in bytes. */
  readonly size: number;
}

// The part of a body that isn't a bundle's description, as a fixed code for the log.
export type BundleFault = "body" | "sha256" | "size";

// `{ "sha256": "<64 hex digits>", "size": <bytes> }`, and nothing else: a field the API doesn't
// know is refused, so a pipeline never believes it said something that was ignored.
export function bundleOf(event: FunctionUrlEvent): Bundle | BundleFault {
  const body = bodyText(event);
  if (body === undefined || body.length > MAX_BODY_LENGTH) return "body";

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "body";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "body";
  }
  // Own fields only: `JSON.parse` gives an object whose prototype answers to other names.
  const fields = new Map<string, unknown>(Object.entries(parsed));
  if ([...fields.keys()].some((name) => !FIELDS.has(name))) return "body";

  const sha256 = fields.get("sha256");
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) return "sha256";
  const size = fields.get("size");
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_BUNDLE_BYTES
  ) {
    return "size";
  }
  return { sha256, size };
}

function bodyText(event: FunctionUrlEvent): string | undefined {
  if (event.body === undefined) return undefined;
  return event.isBase64Encoded === true
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
}
