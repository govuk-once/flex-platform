import type { Authorise, TakesUploads } from "./authorise.ts";
import type { SignUpload } from "./sign-upload.ts";
import type { VerifyToken } from "./token.ts";

/** What the API does its work through, given when the handler is made. */
export interface CiOptions {
  readonly verifyToken: VerifyToken;
  readonly authorise: Authorise;
  readonly takesUploads: TakesUploads;
  readonly signUpload: SignUpload;
  /** The time now, in milliseconds. */
  readonly now: () => number;
}
