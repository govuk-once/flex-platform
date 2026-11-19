// What a pipeline says of the bundle it is about to upload, or asks to release.

import { isBundleVersion } from "@repo/shared-release/bundle-version";

import type { FunctionUrlEvent } from "./types.ts";

/**
 * The most a bundle may weigh: what Lambda allows a function's code to unzip to, which no zip of
 * it usefully exceeds.
 */
export const MAX_BUNDLE_BYTES = 250 * 1024 * 1024;

// The request's body is at most three short fields. Far longer is not one.
const MAX_BODY_LENGTH = 1024;

// A SHA-256 in hex, in lowercase, so one bundle has one key.
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface Bundle {
  /** The zip's SHA-256, in lowercase hex. */
  readonly sha256: string;
  /** The zip's length in bytes. */
  readonly size: number;
}

/** A bundle a pipeline is about to upload, and the version it names it. */
export interface Upload extends Bundle {
  readonly version: string;
}

// The part of a body that isn't a bundle's description, as a fixed code for the log.
export type BundleFault = "body" | "version" | "sha256" | "size";

// `{ "version": "<major.minor.patch>", "sha256": "<64 hex digits>", "size": <bytes> }`, and
// nothing else: a field the API doesn't know is refused, so a pipeline never believes it said
// something that was ignored.
export function uploadOf(event: FunctionUrlEvent): Upload | BundleFault {
  const fields = fieldsOf(event, UPLOAD_FIELDS);
  if (fields === "body") return fields;

  const version = fields.get("version");
  if (typeof version !== "string" || !isBundleVersion(version)) {
    return "version";
  }
  const sha256 = fields.get("sha256");
  if (!isSha256(sha256)) return "sha256";
  const size = fields.get("size");
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_BUNDLE_BYTES
  ) {
    return "size";
  }
  return { version, sha256, size };
}

/** The bundle a pipeline asks to release, by the hash it was uploaded with. */
export interface Release {
  readonly sha256: string;
}

// `{ "sha256": "<64 hex digits>" }`, and nothing else, for the same reason.
export function releaseOf(event: FunctionUrlEvent): Release | BundleFault {
  const fields = fieldsOf(event, RELEASE_FIELDS);
  if (fields === "body") return fields;

  const sha256 = fields.get("sha256");
  if (!isSha256(sha256)) return "sha256";
  return { sha256 };
}

const UPLOAD_FIELDS: ReadonlySet<string> = new Set([
  "version",
  "sha256",
  "size",
]);

const RELEASE_FIELDS: ReadonlySet<string> = new Set(["sha256"]);

// The body's fields, if it is a JSON object of short length that names no others.
function fieldsOf(
  event: FunctionUrlEvent,
  allowed: ReadonlySet<string>,
): ReadonlyMap<string, unknown> | "body" {
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
  if ([...fields.keys()].some((name) => !allowed.has(name))) return "body";
  return fields;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function bodyText(event: FunctionUrlEvent): string | undefined {
  if (event.body === undefined) return undefined;
  return event.isBase64Encoded === true
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
}
