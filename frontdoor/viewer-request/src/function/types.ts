// The CloudFront Functions viewer request event, and the response a function can return.

import type { TrustedIssuer } from "@repo/frontdoor-shared";

// A repeated header, query parameter or cookie keeps its first value in `value` and every value,
// in order, in `multiValue`.
export interface FieldValue {
  value: string;
  multiValue?: { value: string }[];
}

export interface CloudFrontRequest {
  method: string;
  uri: string;
  querystring: Record<string, FieldValue>;
  headers: Record<string, FieldValue>;
  cookies: Record<string, FieldValue>;
}

export interface ViewerRequestEvent {
  version: string;
  context: {
    distributionDomainName: string;
    distributionId: string;
    eventType: string;
    requestId: string;
  };
  viewer: { ip: string };
  request: CloudFrontRequest;
}

export interface CloudFrontResponse {
  statusCode: number;
  headers: Record<string, { value: string }>;
  body: { encoding: "text"; data: string };
}

// Baked into the function when it is built, once per environment.
export interface ViewerRequestConfig {
  readonly issuers: readonly TrustedIssuer[];
}
