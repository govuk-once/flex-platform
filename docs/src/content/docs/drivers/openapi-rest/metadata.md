---
title: Response metadata
description: Reporting upstream response headers to callers under neutral names.
---

`metadata` names what the gateway [reports beside a result](/flex-platform/gateways/responses/#response-metadata).
For each name it gives the response header the value is read from, and the schema of the value:

```ts
openapiRest({
  spec: "…",
  auth: [],
  metadata: {
    upstreamRequestId: {
      header: "X-Request-Id",
      schema: { type: "string", maxLength: 128, description: "The upstream's id for the request" },
    },
  },
});
```

A caller reads `meta.upstreamRequestId`. The caller never sees the header's name, because that
belongs to this transport.

## Choosing what to report

The schema belongs to the gateway, and is best kept loose. Its job is to limit what reaches a
caller and a log. If an upstream changes how its ids look, nothing a caller relies on has
changed. So what an OpenAPI document says about a response header is not used.

Every value is returned to the caller and written to the log. The gateway author decides which
headers to pass on. Set a `maxLength` on each string, so that an unexpectedly long value reaches
neither.

## How headers are read

A header is text. If its schema is a number, an integer or a boolean, the text is read as that
type when it can be. Otherwise it is left as text, and the gateway's validator refuses it.

A whole number beyond ±(2^53 − 1) is also left as text. It has no exact double, so reading it
would round it to a nearby number that still passes validation. RFC 7493 limits an interoperable
JSON integer to the same range, so a caller in any language might not read it exactly either. If a
value can be that large, such as a numeric id, declare it as a string.

Headers are read as they arrive, before the body and before the status is mapped. So metadata is
reported in these cases, as it is for a success:

- a response the driver turns into an error code;
- an exchange whose body was too large;
- an exchange whose stream broke.

This lets a caller get the upstream's own id for a request that failed. A response whose headers
never arrived reports nothing.

## Agreement with the schemas

Deriving copies each schema into the gateway's `meta`. Codegen fails when:

- a name is in the schemas but not in `metadata`;
- a name is in `metadata` but not in the schemas;
- the two disagree about what the header holds.

The configured schema decides what type the text is read as. The stored schema decides what
passes validation. If they disagree, a value can be dropped from every response without any
warning. For example, a count read from a header that the schemas hold to a string would always
be dropped. The executor refuses to start if it cannot read `metadata`.
