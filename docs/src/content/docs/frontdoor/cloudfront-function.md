---
title: CloudFront Function
description: The Frontdoor's first check on each request, of its method, token, path and content type, before Lambda@Edge is paid to look at it.
---

A **CloudFront Function**, `frontdoor-<environment>-viewer-request`, runs on each request as it
arrives, after [WAF](/flex-platform/frontdoor/overview/#waf). It checks the request's structure,
and stops a malformed request from going any further. It verifies no signature.
[Lambda@Edge](/flex-platform/frontdoor/lambda-edge/) does that. The code is in
`frontdoor/viewer-request`.

## The checks

The function runs these steps in order:

1. **Gives the request its ID.** It derives an ID in AWS X-Ray's trace ID format from the time
   and CloudFront's request ID, such as `1-5759e988-bd862e3fe1be46a994272793`. It sets the ID as
   `x-correlation-id`. The app reads that header, and every later hop logs it. The function
   removes any `X-Amzn-Trace-Id`, `traceparent` or `tracestate` the caller sent, and replaces any
   `x-correlation-id`. A caller who chose the trace could tie requests together, or force every
   one to be sampled. The edge records no X-Ray span, and the X-Ray trace starts at API Gateway
   ([why](/flex-platform/frontdoor/lambda-edge/#signing)).
2. **Removes every `x-flex-` header** the caller sent. Only the platform sets those.
3. **Checks the method.** `GET`, `POST`, `PUT`, `PATCH` and `DELETE` pass. The function answers
   anything else, `HEAD` and `OPTIONS` included, with a 405 and an `Allow` header. This check
   comes first because its answer says nothing about the caller or the paths.
4. **Checks the token's shape.** The token passes if all of these hold:
   - `Authorization` appears once.
   - It is exactly `Bearer`, one space, and one token of at most 4 KB in three base64url
     segments.
   - The header and payload are JSON objects.
   - `alg` is `RS256`.
   - `iss` is one of the trusted user pools, and `client_id` is one of that pool's trusted app
     clients.
   - `token_use` is `access`.
   - `exp` is a finite time in the future.

   If any check fails, the function answers with a 401 before it looks at the path. So a request
   without a valid token learns nothing about which paths exist.
5. **Checks the path.** The path must be `/app/<domain>/...`, with no empty or dot segment and no
   encoded `/`, `\` or `.`. `<domain>` follows the rule for domain names in config: 1 to 32
   lowercase letters, digits and hyphens, checked by the same `isPlatformName` the config uses.
   The function answers anything else with a 404. It also answers `/app/<domain>/ping` and
   `/app/<domain>/sping` with a 404, because
   [no domain is ever asked for them](/flex-platform/domains/hosting/#routing-a-request).
   Lambda@Edge holds the list of domains, so it decides whether the domain exists. The name
   becomes part of an origin hostname, so it can never carry a dot or a port.
6. **Checks the content type.** A request must say `application/json` if it is a `POST`, `PUT`
   or `PATCH`, or if it announces a body by `content-length` or `transfer-encoding`. The method
   counts on its own because HTTP/2 and HTTP/3 can send a body without either header. The
   function answers anything else with a 415. It also answers with a 415 if any of those three
   headers appears more than once.

The function can't see a body, only the headers that announce one.
[Lambda@Edge](/flex-platform/frontdoor/lambda-edge/#checking-the-request) can see the body. It
checks the method, the path and the body's content type again before it signs.

CloudFront presents a repeated header with its first value in `value`, and every value in
`multiValue`. The function reads `value`, so every header it reads must appear once. Otherwise a
check could pass on the first value while a later step reads another.

### One form per token

WAF's per-token rate limit counts the `Authorization` header's exact value. A token sent in two
forms would have two counts. So the function accepts each token in one form only:

- The scheme is `Bearer`, as written, with one space after it. HTTP allows other cases and
  spacing, but the app sends this form.
- Each segment is written the one way its bytes encode. A base64url decoder ignores the spare
  bits of a segment's last character. Without this rule, an RS256 signature could be written 16
  ways that all verify. Every encoder writes those bits as zero, and the function refuses a
  segment where they aren't.

Lambda@Edge applies the same rules.

## Rejections

Each rejection has the body `{"message": "...", "type": "..."}`, with
`x-rejected-by: cloudfront-function` and the trace ID as `x-correlation-id`. `type` is
`auth_error` for the 401 and `client_error` otherwise. The status says which check failed:

| Status | `message` |
|---|---|
| 401 | `Unauthorized` |
| 404 | `Not found` |
| 405 | `Method not allowed` |
| 415 | `Unsupported media type` |

The app reads a rejection's status, not its body. If any part of the platform answers with a 401
or a 403, the app treats the token as expired. It refreshes its tokens and sends the request once
more.

## Logs

The function writes one log line for every request. The line names the outcome, such as
`viewer_request_token_validated` or `viewer_request_method_rejected`. It holds a fixed reason
code, the trace ID and CloudFront's request ID, and never text from the request. This line is the
one place both IDs appear together, so it joins CloudFront's own logs to the rest of the request.

CloudFront writes a function's logs to `/aws/cloudfront/function/<function name>` in us-east-1,
whichever edge ran it. CloudFront would create that group itself, with no retention. So the stack
creates it first, and the function's name never changes. See
[the Frontdoor's logs](/flex-platform/frontdoor/overview/#logs).

## Building the function

`buildViewerRequestFunction` bakes the trusted issuers and their app clients into the function
for each environment. It doesn't bake in the domain list, because a few hundred names would pass
CloudFront's size limit.

It builds with `buildCloudFrontFunction`, from `@repo/cloudfront-function/build`, which:

- bundles for the `cloudfront-js-2.0` runtime;
- parses the result to check it declares `function handler` at the top level;
- refuses a function over CloudFront's 10 KB limit.

The function's code comes from three packages:

- `@repo/cloudfront-function` holds what is particular to a CloudFront Function: the event's
  types, the checks of a repeated header and of a JSON body, the removal of the headers a caller
  may not send, the refusals, and the log line.
- `@repo/cloudfront-js-utils` holds the generic functions it uses: the trace ID, the encoding
  check, the decoding of a token's segments, the shape of an RS256 token, the check of a path,
  the rule a name follows, and what counts as a JSON content type.
- `@repo/frontdoor-shared` holds the reading of `Authorization`, the methods and the path rule.

Lambda@Edge uses the trace ID, the encoding check, the JSON content type, and everything in
`@repo/frontdoor-shared` too, so the two functions can't disagree on any of them. The function
built for [the pipeline API](/flex-platform/domains/release-pipeline/#the-pipeline-api) uses the first two
packages too.

The function bundles what it imports from those packages, so that code is held to the same rules.
esbuild rewrites syntax the runtime lacks, but not built-ins. So lint refuses what the runtime
doesn't have:

- `Map`, `Set` and `URL`;
- timers and `process`;
- `for...of`;
- any `console` method but a one-argument `log`;
- any import but `crypto` and the packages the function's lint config names.

These rules are `@repo/eslint-config`'s `cloudfrontFunction` preset.
`@repo/cloudfront-js-utils`, `@repo/frontdoor-shared` and the function code in
`@repo/cloudfront-function` all use it throughout.

The package's tests run the built bundle in Node, which proves the bundling and the behaviour. The
lint rules keep to what CloudFront's runtime has. Every request runs the function, so the first
request after a deploy proves the runtime accepts the bundle.
