import type {
  FieldValue,
  ViewerRequestConfig,
  ViewerRequestEvent,
} from "../src/function/types.ts";

export const ISSUER =
  "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_example";

export const CLIENT_ID = "example-app-client";

export const CONFIG: ViewerRequestConfig = {
  issuers: [{ issuer: ISSUER, clientIds: [CLIENT_ID] }],
};

export const NOW = 1_800_000_000;

export const REQUEST_ID =
  "4TyzHTaYWb1GX1qTfsHhEqV6HUDd_BzoBZnwfnvQc_1oF26ClkoUSEQ==";

export function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// An unsigned token shaped like a Cognito access token. The function never checks a signature,
// so any base64url text stands in for one.
export function token(
  header: Record<string, unknown> = {},
  payload: Record<string, unknown> = {},
): string {
  return [
    base64url({ alg: "RS256", kid: "key-1", ...header }),
    base64url({
      iss: ISSUER,
      client_id: CLIENT_ID,
      token_use: "access",
      exp: NOW + 3600,
      username: "pairwise-id",
      ...payload,
    }),
    "c2lnbmF0dXJl",
  ].join(".");
}

// A header given as an array is repeated, as CloudFront presents one: the first value in `value`,
// every value in `multiValue`.
export type TestHeaders = Record<string, string | readonly string[]>;

// CloudFront's documented viewer request event, with what a test changes laid over it.
export function viewerRequestEvent(
  overrides: {
    uri?: string;
    method?: string;
    headers?: TestHeaders;
  } = {},
): ViewerRequestEvent {
  const headers: Record<string, FieldValue> = {};
  const given = overrides.headers ?? { authorization: `Bearer ${token()}` };
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
      method: overrides.method ?? "GET",
      uri: overrides.uri ?? "/app/udp/v1/identity",
      querystring: {
        ID: { value: "42" },
        NoValue: { value: "" },
        querymv: fieldValue(["val1", "val2,val3"]),
      },
      headers,
      cookies: {
        Cookie1: { value: "value1" },
        cookiemv: fieldValue(["value3", "value4"]),
      },
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
