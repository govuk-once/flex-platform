// What Lambda runs. Only the build bundles this module: it replaces CI_CONFIG with a stage's
// config.
import { createAuthoriser } from "./authorise.ts";
import { createCiHandler } from "./handler.ts";
import { createTokenVerifier } from "./token.ts";
import type { CiConfig } from "./types.ts";

declare const CI_CONFIG: CiConfig;

export const handler = createCiHandler({
  verifyToken: createTokenVerifier(CI_CONFIG),
  authorise: createAuthoriser(CI_CONFIG),
  now: () => Date.now(),
});
