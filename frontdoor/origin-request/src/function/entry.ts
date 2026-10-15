// What Lambda@Edge runs. Only the build bundles this module: it replaces ORIGIN_REQUEST_CONFIG
// with an environment's config, because Lambda@Edge has no environment variables of its own.
import { createOriginRequestHandler } from "./origin-request.ts";
import { createTokenVerifier } from "./token.ts";
import type { OriginRequestConfig } from "./types.ts";

declare const ORIGIN_REQUEST_CONFIG: OriginRequestConfig;

// Lambda sets both. They only label the diagnostic response, so neither is worth failing for.
export const handler = createOriginRequestHandler({
  verifyToken: createTokenVerifier(ORIGIN_REQUEST_CONFIG.issuers),
  region: process.env.AWS_REGION ?? "unknown",
  functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION ?? "unknown",
});
