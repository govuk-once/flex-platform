// What the pipeline API asks the release worker to do: release one uploaded bundle to one domain
// in one environment. The API records each release in the release table, then sends the queue a
// message that names it. The table, not the message, says what to release.
//
// Anything in the shared account that IAM allows could invoke the worker with a message of its
// own, and a function's policy can't refuse it. A message only names a release, and the table's
// policy lets no role but the API's record one, so a message the API didn't send names a release
// that isn't there, or one the worker would run anyway.

import { isPlatformName } from "@repo/cloudfront-js-utils/is-platform-name";

import { isBundleVersion } from "./bundle-version.ts";
import { isReleaseId } from "./release-id.ts";

export interface ReleaseRequest {
  readonly environment: string;
  readonly domain: string;
  /** The version of the domain's code, as its pipeline named it when it uploaded the bundle. */
  readonly version: string;
  /** The bundle's SHA-256, in lowercase hex, which its key is named by. */
  readonly sha256: string;
  /** The S3 version of the bundle's object, which the worker reads and Lambda loads. */
  readonly versionId: string;
  /** GitHub's ID for the run that asked, for the log. A token may hold none. */
  readonly runId?: string | undefined;
  /** The commit the run is for, for the log. A token may hold none. */
  readonly commit?: string | undefined;
}

/** A release as the queue carries it: the key of its record in the release table. */
export interface ReleaseMessage {
  readonly environment: string;
  readonly domain: string;
  readonly id: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

// S3 writes a version ID of up to 1,024 bytes. AWS's own examples hold "+" and "/" as well as
// URL-safe characters, so base64's are allowed too.
const VERSION_ID = /^[A-Za-z0-9._+/=-]{1,1024}$/;

const RUN_ID = /^\d{1,20}$/;

const COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

const REQUEST_FIELDS = new Set([
  "environment",
  "domain",
  "version",
  "sha256",
  "versionId",
  "runId",
  "commit",
]);

const MESSAGE_FIELDS = new Set(["environment", "domain", "id"]);

export function encodeReleaseMessage(message: ReleaseMessage): string {
  return JSON.stringify({
    environment: message.environment,
    domain: message.domain,
    id: message.id,
  });
}

/** The release a queue's body names, or `undefined` for one that names none. */
export function parseReleaseMessage(body: string): ReleaseMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const fields = ownFields(parsed, MESSAGE_FIELDS);
  if (fields === undefined) return undefined;

  const environment = fields.get("environment");
  const domain = fields.get("domain");
  const id = fields.get("id");
  if (
    !matches(environment, isPlatformName) ||
    !matches(domain, isPlatformName) ||
    !matches(id, isReleaseId)
  ) {
    return undefined;
  }
  return { environment, domain, id };
}

/** The request, if the value holds one and nothing else. */
export function parseReleaseRequest(
  value: unknown,
): ReleaseRequest | undefined {
  const fields = ownFields(value, REQUEST_FIELDS);
  if (fields === undefined) return undefined;

  const environment = fields.get("environment");
  const domain = fields.get("domain");
  const version = fields.get("version");
  const sha256 = fields.get("sha256");
  const versionId = fields.get("versionId");
  const runId = fields.get("runId");
  const commit = fields.get("commit");
  if (
    !matches(environment, isPlatformName) ||
    !matches(domain, isPlatformName) ||
    !matches(version, isBundleVersion) ||
    !matches(sha256, (value) => SHA256_HEX.test(value)) ||
    !matches(versionId, (value) => VERSION_ID.test(value)) ||
    !optional(runId, (value) => RUN_ID.test(value)) ||
    !optional(commit, (value) => COMMIT.test(value))
  ) {
    return undefined;
  }
  return {
    environment,
    domain,
    version,
    sha256,
    versionId,
    ...(runId !== undefined && { runId }),
    ...(commit !== undefined && { commit }),
  };
}

// An object's own fields, if it is a plain object that names no others. `JSON.parse` gives an
// object whose prototype answers to other names.
function ownFields(
  value: unknown,
  allowed: ReadonlySet<string>,
): ReadonlyMap<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const fields = new Map<string, unknown>(Object.entries(value));
  if ([...fields.keys()].some((name) => !allowed.has(name))) return undefined;
  return fields;
}

/**
 * The queue's message group: one per domain in each environment, so one domain's releases there
 * run in the order they were asked for, and other domains' run alongside.
 */
export function releaseGroup(target: {
  readonly environment: string;
  readonly domain: string;
}): string {
  return `${target.environment}.${target.domain}`;
}

function matches(
  value: unknown,
  test: (value: string) => boolean,
): value is string {
  return typeof value === "string" && test(value);
}

function optional(
  value: unknown,
  test: (value: string) => boolean,
): value is string | undefined {
  return value === undefined || matches(value, test);
}
