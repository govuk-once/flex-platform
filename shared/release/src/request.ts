// What a release is for: one uploaded bundle, released to one domain in one environment.

export interface ReleaseRequest {
  readonly environment: string;
  readonly domain: string;
  /** The bundle's SHA-256, in lowercase hex, which its key is named by. */
  readonly sha256: string;
  /** The version of the bundle's object, which the worker reads and Lambda loads. */
  readonly versionId: string;
  /** GitHub's ID for the run that asked, for the log. A token may hold none. */
  readonly runId?: string | undefined;
  /** The commit the run is for, for the log. A token may hold none. */
  readonly commit?: string | undefined;
}
