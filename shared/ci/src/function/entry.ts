// What Lambda runs. Only the build bundles this module: it replaces CI_CONFIG with a stage's
// config.
import { createAuthoriser, createUploadCheck } from "./authorise.ts";
import { createCiHandler } from "./handler.ts";
import {
  createUploadSigner,
  credentialsFromEnvironment,
} from "./sign-upload.ts";
import { createTokenVerifier } from "./token.ts";
import type { CiConfig } from "./types.ts";

declare const CI_CONFIG: CiConfig;

export const handler = createCiHandler({
  verifyToken: createTokenVerifier(CI_CONFIG),
  authorise: createAuthoriser(CI_CONFIG),
  takesUploads: createUploadCheck(CI_CONFIG),
  signUpload: createUploadSigner({
    uploads: CI_CONFIG.uploads,
    credentials: credentialsFromEnvironment,
    now: () => Date.now(),
  }),
  now: () => Date.now(),
});
