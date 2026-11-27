---
title: Response metadata
description: Reporting upstream response headers to callers under neutral names.
---

`metadata` names what the gateway [reports beside a result](/flex-platform/gateways/responses/#response-metadata).
For each name, it gives the response header to read the value from, and the schema of the value:

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

The gateway author decides which headers to pass on. Every value is returned to the caller and
written to the log. Set a `maxLength` on each string, so that an unexpectedly long value reaches
neither.

The schema belongs to the gateway, and is best kept loose. Its job is to limit what reaches a
caller and a log. With a loose schema, an upstream can change how its ids look without changing
anything a caller relies on. So the driver does not use what an OpenAPI document says about a
response header.

## How headers are read

A header is text. If its schema is a number, an integer or a boolean, the driver reads the text
as that type when it can. Otherwise it leaves the value as text, and the gateway's validator
refuses it.

The driver also leaves a whole number beyond ±(2^53 − 1) as text. Such a number has no exact
double, so reading it would round it to a nearby number that still passes validation. RFC 7493
limits an interoperable JSON integer to the same range, so a caller in any language might not read
it exactly either. If a value can be that large, such as a numeric id, declare it as a string.

The driver reads headers as they arrive, before the body and before it maps the status. So
metadata is reported in these cases, as it is for a success:

- a response the driver turns into an error code;
- an exchange whose body was too large;
- an exchange whose stream broke.

This lets a caller get the upstream's own id for a request that failed. If a response's headers
never arrived, it reports nothing.

## Agreement with the schemas

Deriving copies each schema into the gateway's `meta`. The two must then stay in step, and
codegen fails when:

- a name is in the schemas but not in `metadata`;
- a name is in `metadata` but not in the schemas;
- the two disagree about what the header holds.

The configured schema decides what type the driver reads the text as. The stored schema decides
what passes validation. If they disagree, a value can be dropped from every response without any
warning. For example, if the configuration reads a count from a header but the schemas hold it to
a string, the value is always dropped. The executor refuses to start if it cannot read
`metadata`.
