import { generateKeyPairSync, sign } from "node:crypto";

import type { TrustedIssuer } from "@repo/frontdoor-shared";
import type { Fetcher } from "aws-jwt-verify/https";

import type {
  CloudFrontHeaders,
  OriginRequestEvent,
} from "../src/function/types.ts";

export const ISSUER =
  "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_example";

export const CLIENT_ID = "example-app-client";

export const ISSUERS: readonly TrustedIssuer[] = [
  { issuer: ISSUER, clientIds: [CLIENT_ID] },
];

export const KID = "key-1";

export const NOW = 1_800_000_000;

export const REQUEST_ID =
  "4TyzHTaYWb1GX1qTfsHhEqV6HUDd_BzoBZnwfnvQc_1oF26ClkoUSEQ==";

// The CloudFront Function's trace ID for REQUEST_ID at NOW, as it computes it.
export const TRACE_ID = "1-6b49d200-97575440147627ab6e7b6276";

// The issuer's signing key, and another that no issuer publishes.
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

// Serves each issuer's JWKS in place of the network, and records what was fetched.
export function fakeFetcher(documents: Record<string, unknown>) {
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

export function jwksUri(issuer: string): string {
  return `${issuer}/.well-known/jwks.json`;
}

export function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// A Cognito access token, signed with RS256 by `key`. Set a claim to undefined to leave it out.
export function token(
  options: {
    header?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    key?: KeyPair;
  } = {},
): string {
  const header = base64url({ alg: "RS256", kid: KID, ...options.header });
  const payload = base64url({
    iss: ISSUER,
    client_id: CLIENT_ID,
    token_use: "access",
    exp: NOW + 3600,
    iat: NOW - 60,
    username: "pairwise-id",
    ...options.payload,
  });
  const signature = sign(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    (options.key ?? ISSUER_KEY).privateKey,
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

// A header given as an array is repeated, each value its own entry.
export type TestHeaders = Record<string, string | readonly string[]>;

// CloudFront's documented origin request event, with what a test changes laid over it.
export function originRequestEvent(
  overrides: { headers?: TestHeaders } = {},
): OriginRequestEvent {
  const given = overrides.headers ?? {
    authorization: `Bearer ${token()}`,
    "x-correlation-id": TRACE_ID,
  };
  const headers: CloudFrontHeaders = {
    "x-forwarded-for": [{ key: "X-Forwarded-For", value: "203.0.113.178" }],
    "user-agent": [{ key: "User-Agent", value: "Amazon CloudFront" }],
    via: [
      {
        key: "Via",
        value:
          "2.0 2afae0d44e2540f472c0635ab62c232b.cloudfront.net (CloudFront)",
      },
    ],
    host: [{ key: "Host", value: "example.org" }],
  };
  for (const [name, value] of Object.entries(given)) {
    const values = typeof value === "string" ? [value] : value;
    headers[name] = values.map((each) => ({ key: name, value: each }));
  }
  return {
    Records: [
      {
        cf: {
          config: {
            distributionDomainName: "d111111abcdef8.cloudfront.net",
            distributionId: "EDFDVBD6EXAMPLE",
            eventType: "origin-request",
            requestId: REQUEST_ID,
          },
          request: {
            clientIp: "203.0.113.178",
            headers,
            method: "GET",
            querystring: "",
            uri: "/app/udp/v1/identity",
          },
        },
      },
    ],
  };
}
