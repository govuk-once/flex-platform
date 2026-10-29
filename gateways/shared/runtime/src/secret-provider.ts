import { SecretsProvider } from "@aws-lambda-powertools/parameters/secrets";
import type { SecretObject, SecretProvider } from "@repo/gateway-types";
import { isRecord } from "@repo/utils/is-record";

import { GatewayError } from "./errors.ts";

// arn:<partition>:secretsmanager:<region>:<account>:secret:<name>. The secret must be in the
// gateway's own region: the gateway reaches Secrets Manager through its network's endpoint, which
// serves that region only. A secret held elsewhere is replicated to it.
const SECRET_ARN = /^arn:[^:\s]+:secretsmanager:([^:\s]+):[^:\s]*:secret:\S+$/;

// How long Powertools serves a retrieved secret before the next call retrieves it again.
// Concurrent calls on a cold or expired cache may each retrieve; nothing coordinates them, and
// a duplicate read costs a request and nothing else.
const MAX_AGE_SECONDS = 300;

// SDK-level bounds on one retrieval, so initialisation cannot hang on the store. A request's
// attempt keeps its own deadline: a caller that runs out of budget stops waiting, and the
// retrieval completes, or fails, on its own.
const CONNECTION_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 5_000;

function describeJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

// The deployment contract requires a JSON object. Diagnostics say what shape was found, never
// what it contained.
export function asSecretObject(value: unknown): SecretObject {
  if (value === undefined) {
    throw new GatewayError(
      "INTERNAL",
      "Gateway secret has no value; it must be a JSON object",
    );
  }
  if (!isRecord(value)) {
    throw new GatewayError(
      "INTERNAL",
      `Gateway secret must be a JSON object, not ${describeJsonType(value)}`,
    );
  }
  return value;
}

// One Powertools SecretsProvider per gateway, reading the secret the ARN names with the
// workload's AWS identity, in the gateway's region. Powertools keeps the cache; this wrapper adds
// the deployment contract and controlled diagnostics. Nothing here knows what the secret
// contains: validating its fields is the driver's job, on every read.
export function createSecretProvider(
  arn: string,
  gatewayRegion: string,
): SecretProvider {
  const region =
    typeof arn === "string" ? SECRET_ARN.exec(arn)?.[1] : undefined;
  if (region === undefined) {
    throw new TypeError("Secret provider needs a Secrets Manager secret ARN");
  }
  // Refused as the gateway starts, rather than timing out on the first read.
  if (region !== gatewayRegion) {
    throw new TypeError(
      `Secret provider needs a secret in the gateway's region, ${gatewayRegion}, not ${region}; replicate it there`,
    );
  }
  const secrets = new SecretsProvider({
    clientConfig: {
      region,
      // Without throwOnRequestTimeout the SDK only logs a breach of requestTimeout.
      requestHandler: {
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        requestTimeout: REQUEST_TIMEOUT_MS,
        throwOnRequestTimeout: true,
      },
    },
  });
  return {
    async get(options) {
      let value: unknown;
      try {
        value = await secrets.get(arn, {
          maxAge: MAX_AGE_SECONDS,
          transform: "json",
          ...(options?.fresh === true ? { forceFetch: true } : {}),
        });
      } catch {
        // The SDK's or the transform's error can carry the request, the response or the text
        // that failed to parse; nothing of it is kept.
        throw new GatewayError("INTERNAL", "Failed to retrieve gateway secret");
      }
      return asSecretObject(value);
    },
  };
}
