// The Lambda@Edge origin request event, the request a function returns to forward it, and the
// response a function can generate in its place.

import type { TrustedIssuer } from "@repo/frontdoor-shared";

// Keyed by the lowercase header name. Each value of a repeated header is its own entry, and `key`
// holds the name as the caller wrote it.
export type CloudFrontHeaders = Record<
  string,
  { key?: string; value: string }[] | undefined
>;

// The body, which the association includes. A request without one, such as a GET, still has the
// field, with empty `data` (the SigV4 probe, 15 October 2026). CloudFront always gives it base64-encoded, and
// truncates one over 1 MB. With `action` left as `read-only`, CloudFront forwards the body it
// received, which is what the signature's hash is over.
export interface CloudFrontRequestBody {
  action: "read-only" | "replace";
  data: string;
  encoding: "base64" | "text";
  inputTruncated: boolean;
}

// Where CloudFront sends the request: exactly one of a custom or an S3 origin. It arrives as the
// distribution's S3 default origin, which the function never reads, and a forwarded request
// leaves as the domain's custom origin.
export type CloudFrontOrigin =
  { custom: CloudFrontCustomOrigin } | { s3: Record<string, unknown> };

export interface CloudFrontCustomOrigin {
  customHeaders: CloudFrontHeaders;
  domainName: string;
  keepaliveTimeout: number;
  path: string;
  port: number;
  protocol: "https";
  readTimeout: number;
  sslProtocols: string[];
}

export interface CloudFrontRequest {
  body: CloudFrontRequestBody;
  clientIp: string;
  headers: CloudFrontHeaders;
  method: string;
  origin: CloudFrontOrigin;
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
  /** Each domain's API host, by domain name. A domain with no entry is a 404. */
  readonly routes: Readonly<Record<string, string>>;
}
