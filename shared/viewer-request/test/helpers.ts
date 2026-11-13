import type { FieldValue, ViewerRequestEvent } from "@repo/cloudfront-function";

import type { ViewerRequestConfig } from "../src/function/types.ts";

export const ISSUER = "https://token.actions.githubusercontent.com";

export const AUDIENCE = "https://sandbox.flex-shared.example/ci";

export const CONFIG: ViewerRequestConfig = {
  issuer: ISSUER,
  audience: AUDIENCE,
};

export const NOW = 1_800_000_000;

export const REQUEST_ID =
  "4TyzHTaYWb1GX1qTfsHhEqV6HUDd_BzoBZnwfnvQc_1oF26ClkoUSEQ==";

export const UPLOADS = "/ci/environments/development/domains/example/uploads";

// The SHA-256 of an empty body, standing in for any body's.
export const CONTENT_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// An unsigned token shaped like the one GitHub issues a job. The function never checks a
// signature, so any base64url text stands in for one.
export function token(
  header: Record<string, unknown> = {},
  payload: Record<string, unknown> = {},
): string {
  return [
    base64url({ alg: "RS256", kid: "key-1", typ: "JWT", ...header }),
    base64url({
      iss: ISSUER,
      aud: AUDIENCE,
      exp: NOW + 300,
      repository: "example-org/example-domain",
      repository_id: "100000001",
      repository_owner_id: "200000002",
      environment: "development",
      ...payload,
    }),
    "c2lnbmF0dXJl",
  ].join(".");
}

// A header given as an array is repeated, as CloudFront presents one: the first value in `value`,
// every value in `multiValue`.
export type TestHeaders = Record<string, string | readonly string[]>;

/** What a pipeline's request carries, for a test to add to or replace. */
export function pipelineHeaders(overrides: TestHeaders = {}): TestHeaders {
  return {
    "x-flex-ci-token": token(),
    "content-type": "application/json",
    "x-amz-content-sha256": CONTENT_HASH,
    ...overrides,
  };
}

// CloudFront's documented viewer request event, with what a test changes laid over it.
export function viewerRequestEvent(
  overrides: {
    uri?: string;
    method?: string;
    headers?: TestHeaders;
  } = {},
): ViewerRequestEvent {
  const headers: Record<string, FieldValue> = {};
  const given = overrides.headers ?? pipelineHeaders();
  for (const [name, value] of Object.entries(given)) {
    headers[name] = fieldValue(value);
  }
  return {
    version: "1.0",
    context: {
      distributionDomainName: "d111111abcdef8.cloudfront.net",
      distributionId: "EDFDVBD6EXAMPLE",
      eventType: "viewer-request",
      requestId: REQUEST_ID,
    },
    viewer: { ip: "198.51.100.11" },
    request: {
      method: overrides.method ?? "POST",
      uri: overrides.uri ?? UPLOADS,
      querystring: {},
      headers,
      cookies: {},
    },
  };
}

function fieldValue(value: string | readonly string[]): FieldValue {
  if (typeof value === "string") return { value };
  return {
    value: value[0] ?? "",
    multiValue: value.map((each) => ({ value: each })),
  };
}
