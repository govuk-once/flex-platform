// Turns a verified request into the one CloudFront sends to the domain: its origin, its path,
// without the caller's token, and signed.

import type { Route } from "./route.ts";
import { SIGNED_HEADERS, type SignRequest } from "./sign.ts";
import type {
  CloudFrontCustomOrigin,
  CloudFrontHeaders,
  CloudFrontRequest,
} from "./types.ts";

// What the domain's API Gateway is reached over. Its own timeout is 29 seconds.
function customOrigin(host: string): CloudFrontCustomOrigin {
  return {
    customHeaders: {},
    domainName: host,
    keepaliveTimeout: 5,
    path: "",
    port: 443,
    protocol: "https",
    readTimeout: 30,
    sslProtocols: ["TLSv1.2"],
  };
}

/** The header that will carry the platform's signed caller token, which a domain passes on. */
export const CALLER_TOKEN_HEADER = "x-flex-secure";

// Until the signed caller token is built: fixed, and holding nothing about the caller.
const CALLER_TOKEN_PLACEHOLDER = "placeholder";

// The headers the function sets. Every other header on the result is one CloudFront gave it.
//
// CloudFront forwards a header a Lambda@Edge function adds only some of the time unless the
// origin request policy names it. The SigV4 probe (15 October 2026) saw unnamed headers arrive
// about half the time, from one function version, in one region, through one edge location.
// `host` and AWS's `x-amz-*` signing headers always arrived. So every other header here must be
// in the origin request policy, and frontdoor/infra's tests hold it there.
const SET_HEADERS = new Map([
  ["authorization", "Authorization"],
  ["host", "Host"],
  ["x-amz-date", "X-Amz-Date"],
  ["x-amz-security-token", "X-Amz-Security-Token"],
  [CALLER_TOKEN_HEADER, "X-Flex-Secure"],
]);

/** The headers the function sets on a forwarded request. */
export const HEADERS_SET_BY_FUNCTION: readonly string[] = [
  ...SET_HEADERS.keys(),
];

// What CloudFront accepts in a header value the function sets.
const HEADER_VALUE = /^[\x20-\x7e]*$/;

// A forwarded body was cut short, so its hash wouldn't be the body's. WAF refuses a body over
// 16 KB, and CloudFront truncates one over 1 MB, so this shouldn't happen.
export class TruncatedBody extends Error {}

// A result CloudFront would refuse, which it would log, with the request's path, where the
// platform can't control or forward the log. Refused here instead, as the fixed 500.
export class InvalidResult extends Error {}

export async function forward(
  request: CloudFrontRequest,
  route: Route,
  sign: SignRequest,
): Promise<CloudFrontRequest> {
  if (request.body.inputTruncated) throw new TruncatedBody();
  const body =
    request.body.data === ""
      ? new Uint8Array()
      : new Uint8Array(
          Buffer.from(
            request.body.data,
            request.body.encoding === "base64" ? "base64" : "utf8",
          ),
        );

  const headers: CloudFrontHeaders = { ...request.headers };
  // Explicitly, rather than trusting the signature to replace it: the domain never sees the
  // caller's token.
  delete headers.authorization;
  // Set before signing, so the signature covers it. The CloudFront Function has already removed
  // any copy a caller sent.
  headers[CALLER_TOKEN_HEADER] = [
    { key: "X-Flex-Secure", value: CALLER_TOKEN_PLACEHOLDER },
  ];

  const signing = await sign({
    method: request.method,
    host: route.host,
    path: route.path,
    querystring: request.querystring,
    headers: signedHeaders(headers),
    body,
  });
  for (const [name, value] of Object.entries({
    ...signing,
    host: route.host,
  })) {
    headers[name] = [{ key: SET_HEADERS.get(name) ?? name, value }];
  }

  // The body is left as it was, read-only, so CloudFront sends what was hashed.
  const forwarded: CloudFrontRequest = {
    ...request,
    headers,
    origin: { custom: customOrigin(route.host) },
    uri: route.path,
  };
  checkResult(request.headers, forwarded);
  return forwarded;
}

// The headers the signature covers that the request carries once each.
function signedHeaders(headers: CloudFrontHeaders): Record<string, string> {
  return Object.fromEntries(
    SIGNED_HEADERS.flatMap((name) => {
      const values = headers[name];
      return values?.length === 1 && values[0] !== undefined
        ? [[name, values[0].value]]
        : [];
    }),
  );
}

// The function adds no header but its own, and each of those is well formed.
function checkResult(
  received: CloudFrontHeaders,
  forwarded: CloudFrontRequest,
): void {
  for (const [name, values] of Object.entries(forwarded.headers)) {
    if (!SET_HEADERS.has(name)) {
      if (!Object.hasOwn(received, name)) {
        throw new InvalidResult(`added a header it doesn't own: ${name}`);
      }
      continue;
    }
    if (values?.length !== 1) {
      throw new InvalidResult(`set ${name} more than once`);
    }
    const [header] = values;
    if (
      header?.key?.toLowerCase() !== name ||
      !HEADER_VALUE.test(header.value)
    ) {
      throw new InvalidResult(`set ${name} badly`);
    }
  }
}
