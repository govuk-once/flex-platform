// What Lambda@Edge runs. Only the build bundles this module: it replaces ORIGIN_REQUEST_CONFIG
// with an environment's config, because Lambda@Edge has no environment variables of its own.
import { KMSClient } from "@aws-sdk/client-kms";
import { SSMClient } from "@aws-sdk/client-ssm";
import { SIGNING_KEY_REGION } from "@repo/frontdoor-shared";

import {
  createCallerTokenSigner,
  createSigningKeyLoader,
} from "./caller-token.ts";
import { createOriginRequestHandler } from "./origin-request.ts";
import { createRequestSigner, credentialsFromEnvironment } from "./sign.ts";
import { createTokenVerifier } from "./token.ts";
import type { OriginRequestConfig } from "./types.ts";

declare const ORIGIN_REQUEST_CONFIG: OriginRequestConfig;

// One attempt per call: the loader waits before reading again, and keeps the keys it has meanwhile,
// so a retry here would only spend the request's time.
const SIGNING_REGION_CLIENT = {
  region: SIGNING_KEY_REGION,
  credentials: () => Promise.resolve(credentialsFromEnvironment()),
  maxAttempts: 1,
};

export const handler = createOriginRequestHandler({
  verifyToken: createTokenVerifier(ORIGIN_REQUEST_CONFIG.issuers),
  routes: new Map(Object.entries(ORIGIN_REQUEST_CONFIG.routes)),
  sign: createRequestSigner(credentialsFromEnvironment),
  signCallerToken: createCallerTokenSigner({
    audience: ORIGIN_REQUEST_CONFIG.callerTokenAudience,
    loadKey: createSigningKeyLoader({
      ssm: new SSMClient(SIGNING_REGION_CLIENT),
      kms: new KMSClient(SIGNING_REGION_CLIENT),
      parameterName: ORIGIN_REQUEST_CONFIG.signingKeyParameter,
    }),
  }),
});
