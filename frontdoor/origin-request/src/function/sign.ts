// AWS Signature Version 4 over a forwarded request, for a domain's API, which checks it with IAM
// authorisation. The credentials are the function's role's, which Lambda rotates and gives each
// invocation in its reserved environment variables; there is no secret to keep.

import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";

/** Every domain's API is in the platform's home region. */
export const SIGNING_REGION = "eu-west-2";

const SERVICE = "execute-api";

// The only headers the signature covers, besides the host and its own. CloudFront adds and
// changes headers after the function returns (`Via`, `X-Forwarded-For`), so a signature over
// those would fail at the origin. Each is signed only when it has one value, so what is signed is
// exactly what is sent. `x-flex-secure` is the function's own.
export const SIGNED_HEADERS = [
  "accept",
  "content-type",
  "x-correlation-id",
  "x-flex-secure",
];

// A query name an object literal reads as its prototype. The signer canonicalises a query through
// an ordinary object, so it would leave the name out of the signature while the request still
// carried it, and the origin would refuse the request.
const UNSIGNABLE_QUERY = "__proto__";

export interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface RequestToSign {
  readonly method: string;
  readonly host: string;
  /** The path as it is sent, escapes and all. */
  readonly path: string;
  /** The query as CloudFront gives it, without the `?`. */
  readonly querystring: string;
  /** The headers the signature covers, by lowercase name, the host aside. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/** The headers that carry the signature, to set on the request. */
export type SignatureHeaders = Readonly<Record<string, string>>;

export type SignRequest = (request: RequestToSign) => Promise<SignatureHeaders>;

/**
 * `credentials` is called for each request, since the role's credentials are rotated. `now`
 * replaces the clock in tests.
 */
export function createRequestSigner(
  credentials: () => Credentials,
  now?: () => Date,
): SignRequest {
  return async (request) => {
    const signer = new SignatureV4({
      service: SERVICE,
      region: SIGNING_REGION,
      credentials: credentials(),
      sha256: Hash.bind(null, "sha256"),
      // The body's hash is signed either way. An API Gateway stage doesn't ask for it in a header.
      applyChecksum: false,
    });
    const signed = await signer.sign(
      {
        method: request.method,
        protocol: "https:",
        hostname: request.host,
        path: request.path,
        query: parseQuery(request.querystring),
        headers: { ...request.headers, host: request.host },
        body: request.body,
      },
      now === undefined ? {} : { signingDate: now() },
    );
    const headers = new Map(
      Object.entries(signed.headers).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    );
    return Object.fromEntries(
      ["authorization", "x-amz-date", "x-amz-security-token"].flatMap(
        (name) => {
          const value = headers.get(name);
          return value === undefined ? [] : [[name, value]];
        },
      ),
    );
  };
}

// The query decoded once, as API Gateway reads it to check a signature: a "+" is a space, as in a
// form (the SigV4 probe, 15 October 2026, saw `a=x+y` canonicalised as `a=x%20y`). A name that
// repeats keeps every value.
function parseQuery(querystring: string): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  const decode = (text: string) => decodeURIComponent(text.replace(/\+/g, " "));
  for (const pair of querystring.split("&")) {
    if (pair === "") continue;
    const equals = pair.indexOf("=");
    const name = decode(equals === -1 ? pair : pair.slice(0, equals));
    const value = equals === -1 ? "" : decode(pair.slice(equals + 1));
    if (name === UNSIGNABLE_QUERY) {
      throw new TypeError(
        `A query parameter named "${UNSIGNABLE_QUERY}" cannot be signed`,
      );
    }
    const existing = Object.hasOwn(query, name) ? query[name] : undefined;
    query[name] =
      existing === undefined
        ? value
        : [...(Array.isArray(existing) ? existing : [existing]), value];
  }
  return query;
}

/** The role's credentials, from the variables Lambda sets for each invocation. */
export function credentialsFromEnvironment(): Credentials {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("The role's credentials aren't in the environment");
  }
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };
}
