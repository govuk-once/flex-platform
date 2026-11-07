// What Lambda@Edge runs. Only the build bundles this module: it replaces ORIGIN_REQUEST_CONFIG
// with an environment's config, because Lambda@Edge has no environment variables of its own.
import { SIGNING_KEY_REGION } from "@repo/frontdoor-shared";

import { createAwsJsonCall } from "./aws-json.ts";
import {
  createCallerTokenSigner,
  createSigningKeyLoader,
} from "./caller-token.ts";
import { createOriginRequestHandler } from "./origin-request.ts";
import { createRequestSigner, credentialsFromEnvironment } from "./sign.ts";
import { createTokenVerifier } from "./token.ts";
import type { OriginRequestConfig } from "./types.ts";

declare const ORIGIN_REQUEST_CONFIG: OriginRequestConfig;

export const handler = createOriginRequestHandler({
  verifyToken: createTokenVerifier(ORIGIN_REQUEST_CONFIG.issuers),
  routes: new Map(Object.entries(ORIGIN_REQUEST_CONFIG.routes)),
  sign: createRequestSigner(credentialsFromEnvironment),
  signCallerToken: createCallerTokenSigner({
    audience: ORIGIN_REQUEST_CONFIG.callerTokenAudience,
    loadKey: createSigningKeyLoader({
      call: createAwsJsonCall(credentialsFromEnvironment),
      parameterName: ORIGIN_REQUEST_CONFIG.signingKeyParameter,
      region: SIGNING_KEY_REGION,
    }),
  }),
});
