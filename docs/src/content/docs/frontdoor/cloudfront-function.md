---
title: CloudFront Function
description: The Frontdoor's first check on each request, of its method, token, path and content type, before Lambda@Edge is paid to look at it.
---

A **CloudFront Function**, `frontdoor-<environment>-viewer-request`, runs on each request as it
arrives, after [WAF](/flex-platform/frontdoor/overview/#waf). It checks the request's structure,
and a malformed request goes no further. It verifies no signature:
[Lambda@Edge](/flex-platform/frontdoor/lambda-edge/) does that. The code is in
`frontdoor/viewer-request`.

## The checks

In order, it:

1. **Gives the request its ID.** It derives an ID in AWS X-Ray's trace ID format from the time
   and CloudFront's request ID, such as `1-5759e988-bd862e3fe1be46a994272793`, and sets it as
   `x-correlation-id`: the header the app reads, and every later hop logs. It removes any
   `X-Amzn-Trace-Id`, `traceparent` or `tracestate`, and replaces any `x-correlation-id`, the
   caller sent. A caller who chose the trace could tie requests together or force every one to be
   sampled. The edge records no X-Ray span, and the X-Ray trace starts at API Gateway
   ([why](/flex-platform/frontdoor/lambda-edge/#signing)).
2. **Removes every `x-flex-` header** the caller sent. Only the platform sets those.
3. **Checks the method.** `GET`, `POST`, `PUT`, `PATCH` and `DELETE` pass. Anything else, `HEAD`
   and `OPTIONS` included, is a 405 with an `Allow` header. This comes first because its answer
   says nothing about the caller or the paths.
4. **Checks the token's shape.** `Authorization` appears once, and is exactly `Bearer`, one
   space, and one token of at most 4 KB in three base64url segments. The header and payload are
   JSON objects. `alg` is `RS256`, `iss` is one of the trusted user pools, `client_id` is one of
   that pool's trusted app clients, `token_use` is `access`, and `exp` is a finite time in the
   future. A failure is a 401, before the path is looked at, so a request without a valid token
   learns nothing about which paths exist.
5. **Checks the path.** It is `/app/<domain>/...`, where `<domain>` follows the rule for domain
   names in config (1 to 32 lowercase letters, digits and hyphens, checked by the same
   `isPlatformName` the config uses), with no empty or dot segment and no encoded `/`, `\` or
   `.`. Anything else is a 404. Whether the domain exists is for Lambda@Edge, which holds the
   list. The name becomes part of an origin hostname, so it can never carry a dot or a port.
6. **Checks the content type.** A `POST`, `PUT` or `PATCH`, or any request announcing a body by
   `content-length` or `transfer-encoding`, says `application/json`. The method counts on its own
   because HTTP/2 and HTTP/3 can send a body without either header. Anything else is a 415, and
   so is any of those three headers appearing more than once.

CloudFront presents a repeated header with its first value in `value` and every value in
`multiValue`. The function reads `value`, so every header it reads must appear once: otherwise a
check could pass on the first value while a later step reads another.

### One form per token

WAF's per-token rate limit counts the `Authorization` header's exact value, so a token sent in
two forms would have two counts. So the function accepts each token in one form only:

- the scheme is `Bearer`, as written, with one space after it. HTTP allows other cases and
  spacing, but the app sends this form;
- each segment is written the one way its bytes encode. A base64url decoder ignores the spare
  bits of a segment's last character, so an RS256 signature could otherwise be written 16 ways
  that all verify. Every encoder writes those bits as zero, and the function refuses a segment
  where they aren't.

Lambda@Edge applies the same rules.

## Rejections

Each rejection has the shape the app handles, `{"message": "...", "type": "..."}`, with
`x-rejected-by: cloudfront-function` and the trace ID as `x-correlation-id`. `type` is
`auth_error` for the 401 and `client_error` otherwise, and the status says which failure it is:

| Status | `message` |
|---|---|
| 401 | `Unauthorized` |
| 404 | `Not found` |
| 405 | `Method not allowed` |
| 415 | `Unsupported media type` |

The app relies on the 401's body exactly, so it never changes.

## Logs

Every request writes one log line naming its outcome, such as `cff_token_validated` or
`cff_method_rejected`, with a fixed reason code, the trace ID and CloudFront's request ID, and
never text from the request. It's the one place both IDs appear together, so it joins CloudFront's
own logs to the rest of the request.

CloudFront writes a function's logs to `/aws/cloudfront/function/<function name>` in us-east-1,
whichever edge ran it. It would create that group itself, with no retention, so the stack
creates it first, and the function's name never changes. See
[the Frontdoor's logs](/flex-platform/frontdoor/overview/#logs).

## Building the function

The trusted issuers and their app clients are baked into the function for each environment by
`buildViewerRequestFunction`. The domain list isn't: a few hundred names would pass CloudFront's
size limit. It bundles for the `cloudfront-js-2.0` runtime, parses the result to check it declares
`function handler` at the top level, and refuses a function over CloudFront's 10 KB limit.

The trace ID, the reading of `Authorization` and the encoding check are in
`@repo/frontdoor-shared`, which Lambda@Edge uses too, so the two functions can't disagree on any
of them. The function bundles that package, so it is held to the same rules. esbuild rewrites
syntax the runtime lacks, but not built-ins, so lint refuses what the runtime doesn't have: `Map`,
`Set`, `URL`, timers, `process`, `for...of`, any `console` method but a one-argument `log`, and
imports other than `crypto`, `isPlatformName` from `@repo/utils` and `@repo/frontdoor-shared`.
These rules are `@repo/eslint-config`'s `cloudfrontFunction` preset, which both packages use.

The package's tests run the built bundle in Node. That proves the bundling and the behaviour. The
lint rules keep to what CloudFront's runtime has, and the first request after a deploy proves the
runtime accepts the bundle, since every request runs the function.
