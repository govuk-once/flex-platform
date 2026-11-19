// What Lambda runs. Only the build bundles this module: it replaces CI_CONFIG with a stage's
// config.
import { createArtefactFinder, createVersionClaim } from "./artefacts.ts";
import { createAuthoriser, createPublishCheck } from "./authorise.ts";
import { createCiHandler } from "./handler.ts";
import { createBundleFinder, createReleaseQueue } from "./release-queue.ts";
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
  publishes: createPublishCheck(CI_CONFIG),
  claimVersion: createVersionClaim({
    uploads: CI_CONFIG.uploads,
    now: () => Date.now(),
  }),
  findArtefact: createArtefactFinder({ uploads: CI_CONFIG.uploads }),
  signUpload: createUploadSigner({
    uploads: CI_CONFIG.uploads,
    credentials: credentialsFromEnvironment,
    now: () => Date.now(),
  }),
  findBundle: createBundleFinder(CI_CONFIG.uploads),
  queueRelease: createReleaseQueue({
    releases: CI_CONFIG.releases,
    region: CI_CONFIG.uploads.region,
    now: () => Date.now(),
  }),
  now: () => Date.now(),
});
