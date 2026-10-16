// The Lambda@Edge origin request event, and the response a function can generate in its place.

import type { TrustedIssuer } from "@repo/frontdoor-shared";

// Keyed by the lowercase header name. Each value of a repeated header is its own entry, and `key`
// holds the name as the caller wrote it.
export type CloudFrontHeaders = Record<
  string,
  { key?: string; value: string }[] | undefined
>;

export interface CloudFrontRequest {
  clientIp: string;
  headers: CloudFrontHeaders;
  method: string;
  querystring: string;
  uri: string;
}

// CloudFront sends one record, as every example in its documentation shows.
export interface OriginRequestEvent {
  Records: [
    {
      cf: {
        config: {
          distributionDomainName: string;
          distributionId: string;
          eventType: string;
          requestId: string;
        };
        request: CloudFrontRequest;
      };
    },
  ];
}

export interface CloudFrontResultResponse {
  status: string;
  statusDescription: string;
  headers: CloudFrontHeaders;
  body: string;
  bodyEncoding: "text";
}

// Baked into the function when it is built, once per environment.
export interface OriginRequestConfig {
  readonly issuers: readonly TrustedIssuer[];
}
