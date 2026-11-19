// One log line per release, in the pipeline API's shape. Every value is a fixed code, an ID AWS,
// GitHub or the pipeline API issued, a name from the table, a bundle's version or hash, a function
// version, or a source location. Never an AWS error's message, which can quote a request, or a message the
// worker couldn't read.

export type ReleaseEventName =
  | "release_done"
  | "release_invalid"
  | "release_unknown"
  | "release_unknown_target"
  | "release_not_claimed"
  | "release_abandoned"
  | "release_not_abandoned"
  | "release_refused"
  | "release_superseded"
  | "release_failed";

export interface ReleaseDetails {
  /** The queue's ID for the message, which joins the attempts at one release. */
  readonly messageId: string;
  readonly durationMs: number;
  /** The pipeline API's ID for the release, which the release table holds it under. */
  readonly releaseId?: string;
  readonly environment?: string;
  readonly domain?: string;
  /** The version of the domain's code the release is for. */
  readonly version?: string;
  readonly sha256?: string;
  readonly runId?: string | undefined;
  readonly commit?: string | undefined;
  /** Where the table had the release, for one that couldn't be claimed or given up. */
  readonly status?: string;
  /** How many times the worker claimed a release that was given up. */
  readonly attempts?: number;
  readonly step?: string;
  readonly reason?: string;
  /** The function version `live` points at, once released. */
  readonly functionVersion?: string;
  readonly created?: boolean;
  readonly moved?: boolean;
  readonly frames?: readonly string[];
}

export function logRelease(
  level: "INFO" | "ERROR",
  event: ReleaseEventName,
  details: ReleaseDetails,
): void {
  console.log(
    JSON.stringify({
      level,
      message: "telemetry",
      telemetry: { event, details },
    }),
  );
}
