// A call to an AWS JSON API, such as SSM's or KMS's, signed with the function's role's
// credentials. The edge makes two, to load its signing key, and bundling an SDK client for each
// would add to every cold start what the signer it already has does.

import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";

import type { Credentials } from "./sign.ts";

// One call's whole budget. Lambda@Edge allows the request 10 seconds, and a key load makes at
// most four calls, two in each region.
const CALL_TIMEOUT_MS = 1_500;

export interface AwsJsonRequest {
  /** Such as `ssm` or `kms`. */
  readonly service: string;
  readonly region: string;
  /** Such as `AmazonSSM.GetParameter`. */
  readonly target: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export type AwsJsonCall = (request: AwsJsonRequest) => Promise<unknown>;

// An AWS error, by the code AWS gives it alone: its message can quote what was asked for.
export class AwsCallFailed extends Error {
  constructor(readonly code: string) {
    super(`An AWS call failed: ${code}`);
  }
}

/**
 * `endpoint` gives the address a service is called at in a region, so a test can stand in for
 * AWS.
 */
export function createAwsJsonCall(
  credentials: () => Credentials,
  endpoint: (service: string, region: string) => string = (service, region) =>
    `https://${service}.${region}.amazonaws.com`,
): AwsJsonCall {
  return async ({ service, region, target, body }) => {
    const url = new URL(endpoint(service, region));
    const payload = JSON.stringify(body);
    const signer = new SignatureV4({
      service,
      region,
      credentials: credentials(),
      sha256: Hash.bind(null, "sha256"),
    });
    const signed = await signer.sign({
      method: "POST",
      protocol: url.protocol,
      hostname: url.hostname,
      ...(url.port === "" ? {} : { port: Number(url.port) }),
      path: "/",
      headers: {
        host: url.host,
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": target,
      },
      body: payload,
    });

    const response = await fetch(url, {
      method: "POST",
      headers: signed.headers,
      body: payload,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new AwsCallFailed(errorCode(text));
    }
    return JSON.parse(text) as unknown;
  };
}

// AWS names an error's type as `__type`, sometimes prefixed with a namespace and `#`.
function errorCode(text: string): string {
  try {
    const { __type } = JSON.parse(text) as { __type?: unknown };
    if (typeof __type === "string") {
      const code = __type.slice(__type.lastIndexOf("#") + 1);
      if (/^\w{1,64}$/.test(code)) return code;
    }
  } catch {
    // Not JSON: no code to give.
  }
  return "Unknown";
}
