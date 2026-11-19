import type { ClaimVersion, FindArtefact } from "./artefacts.ts";
import type { Authorise, Publishes } from "./authorise.ts";
import type { FindBundle, FindRelease, QueueRelease } from "./release-queue.ts";
import type { SignUpload } from "./sign-upload.ts";
import type { VerifyToken } from "./token.ts";

/** What the API does its work through, given when the handler is made. */
export interface CiOptions {
  readonly verifyToken: VerifyToken;
  readonly authorise: Authorise;
  readonly publishes: Publishes;
  readonly claimVersion: ClaimVersion;
  readonly findArtefact: FindArtefact;
  readonly signUpload: SignUpload;
  readonly findBundle: FindBundle;
  readonly queueRelease: QueueRelease;
  readonly findRelease: FindRelease;
  /** The time now, in milliseconds. */
  readonly now: () => number;
}
