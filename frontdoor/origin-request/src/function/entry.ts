// What Lambda@Edge runs. Only the build bundles this module: it replaces ORIGIN_REQUEST_CONFIG
// with an environment's config, because Lambda@Edge has no environment variables of its own.
import { createOriginRequestHandler } from "./origin-request.ts";
import { createRequestSigner, credentialsFromEnvironment } from "./sign.ts";
import { createTokenVerifier } from "./token.ts";
import type { OriginRequestConfig } from "./types.ts";

declare const ORIGIN_REQUEST_CONFIG: OriginRequestConfig;

export const handler = createOriginRequestHandler({
  verifyToken: createTokenVerifier(ORIGIN_REQUEST_CONFIG.issuers),
  routes: new Map(Object.entries(ORIGIN_REQUEST_CONFIG.routes)),
  sign: createRequestSigner(credentialsFromEnvironment),
});
