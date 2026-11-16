import { generateKeyPairSync, sign } from "node:crypto";

import type { Fetcher } from "aws-jwt-verify/https";

import type { CiConfig, FunctionUrlEvent } from "../src/function/types.ts";

export const ISSUER = "https://token.actions.githubusercontent.com";

export const KEYS_URI = `${ISSUER}/.well-known/jwks`;

export const AUDIENCE = "https://sandbox.flex-shared.example/ci";

export const REPOSITORY_ID = "700000001";

export const OWNER_ID = "90000001";

export const CONFIG: CiConfig = {
  issuer: ISSUER,
  keysUri: KEYS_URI,
  audience: AUDIENCE,
  environments: [
    {
      name: "development",
      publishes: true,
      domains: ["example", "unregistered"],
    },
    // Takes its code from development, by promotion.
    { name: "staging", publishes: false, domains: ["example"] },
  ],
  domains: [
    { name: "example", repositoryId: REPOSITORY_ID, ownerId: OWNER_ID },
    // Registered, but no environment hosts it.
    { name: "elsewhere", repositoryId: "700000002", ownerId: OWNER_ID },
  ],
  uploads: { bucket: "shared-domain-code-000000000000", region: "eu-west-2" },
};

export const COMMIT = "0123456789abcdef0123456789abcdef01234567";

// A bundle: the SHA-256 of an empty zip's bytes would do, and so does any 64 hex digits.
export const BUNDLE = {
  sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  size: 4096,
};

export const KID = "key-1";

export const NOW = 1_800_000_000;

export const TRACE_ID = "1-6b49d200-97575440147627ab6e7b6276";

export const LAMBDA_REQUEST_ID = "0f8c1d3e-5b7a-4c2d-9e6f-1a2b3c4d5e6f";

// The issuer's signing key, and another that it doesn't publish.
export const ISSUER_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const OTHER_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 });

type KeyPair = typeof ISSUER_KEY;

export function jwks(keys: readonly { kid: string; key: KeyPair }[]) {
  return {
    keys: keys.map(({ kid, key }) => ({
      ...key.publicKey.export({ format: "jwk" }),
      kid,
      alg: "RS256",
      use: "sig",
    })),
  };
}

// Serves the issuer's keys in place of the network, and records what was fetched.
export function fakeFetcher(
  documents: Record<string, unknown> = {
    [KEYS_URI]: jwks([{ kid: KID, key: ISSUER_KEY }]),
  },
) {
  const fetched: string[] = [];
  const fetcher: Fetcher = {
    fetch: (uri) => {
      fetched.push(uri);
      const document = documents[uri];
      if (document === undefined) return Promise.reject(new Error(uri));
      return Promise.resolve(
        new TextEncoder().encode(JSON.stringify(document)).buffer,
      );
    },
  };
  return { fetcher, fetched };
}

export function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// A token as GitHub issues one to a job in the `development` environment of the registered
// repository, signed with RS256 by `key`, or with RSA over `digest`. Set a claim to undefined to
// leave it out.
export function token(
  options: {
    header?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    key?: KeyPair;
    digest?: "sha256" | "sha512";
  } = {},
): string {
  const header = base64url({ alg: "RS256", kid: KID, ...options.header });
  const payload = base64url({
    iss: ISSUER,
    aud: AUDIENCE,
    exp: NOW + 300,
    iat: NOW - 5,
    nbf: NOW - 5,
    sub: "repo:example-org/example-domain:environment:development",
    repository: "example-org/example-domain",
    repository_id: REPOSITORY_ID,
    repository_owner: "example-org",
    repository_owner_id: OWNER_ID,
    environment: "development",
    run_id: "12345678901",
    sha: COMMIT,
    ...options.payload,
  });
  const signature = sign(
    options.digest ?? "sha256",
    Buffer.from(`${header}.${payload}`),
    (options.key ?? ISSUER_KEY).privateKey,
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

// A function URL's event for a request CloudFront passed on, with what a test changes laid over
// it. A header set to undefined is left out.
export function functionUrlEvent(
  overrides: {
    method?: string;
    path?: string;
    headers?: Record<string, string | undefined>;
    /** The body as sent. `null` for a request with none. */
    body?: string | null;
    isBase64Encoded?: boolean;
  } = {},
): FunctionUrlEvent {
  const body =
    overrides.body === undefined ? JSON.stringify(BUNDLE) : overrides.body;
  return {
    ...(body !== null && { body }),
    ...(overrides.isBase64Encoded !== undefined && {
      isBase64Encoded: overrides.isBase64Encoded,
    }),
    rawPath:
      overrides.path ?? "/ci/environments/development/domains/example/uploads",
    headers: {
      "content-type": "application/json",
      host: "abcdefghijklmnopqrstuvwxyz012345.lambda-url.eu-west-2.on.aws",
      "x-amz-content-sha256":
        "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      "x-correlation-id": TRACE_ID,
      "x-flex-ci-token": token(),
      ...overrides.headers,
    },
    requestContext: {
      requestId: LAMBDA_REQUEST_ID,
      http: { method: overrides.method ?? "POST" },
    },
  };
}
