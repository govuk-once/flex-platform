---
title: Domain configuration
description: The fields of a domain's configuration, the rules each is held to, and how a handler is typed from it.
---

A domain declares its name and routes in `src/domain.ts`, with `defineDomain` from the
[domain SDK](/flex-platform/domains/overview/#domain-sdk). The SDK uses this configuration to:

- type each handler;
- check the configuration as it loads;
- [answer requests](/flex-platform/domains/requests/);
- build the domain's [OpenAPI document](/flex-platform/domains/configuration/#the-openapi-document).

## An example

```ts
// src/domain.ts
import { defineDomain } from "@govuk-once/flex-domain-sdk";

import { listTodos } from "./routes/list-todos.ts";
import { TodoListSchema, TodoQuerySchema } from "./schemas.ts";

const domain = defineDomain({
  name: "domain-a",
  routes: {
    "GET /v1/todos": {
      handler: listTodos,
      query: TodoQuerySchema,
      responses: { 200: TodoListSchema },
    },
    // add more routes...
  },
});

export default domain;

declare module "@govuk-once/flex-domain-sdk" {
  interface Register {
    readonly domain: typeof domain;
  }
}
```

The SDK's test fixture, in `domains/sdk/test/fixtures/`, is a complete example domain with five
routes, its schemas and its handlers.

## The domain

| Field | Rule |
|---|---|
| `name` | 1 to 32 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen |
| `description` | Optional. What the domain does, shown in its OpenAPI document. Not blank |
| `routes` | At least one route, keyed by its [route key](#route-keys) |

## Route keys

A route key names a route's method and path. It has the format `<METHOD> /<version>/<path>`, such
as `GET /v1/todos/{id}`:

- the method is `GET`, `POST`, `PUT`, `PATCH` or `DELETE`;
- the path starts with a version, such as `/v1`, followed by at least one segment;
- a segment is either lowercase letters, digits and hyphens, starting with a letter, or a path
  parameter in camel case, such as `{id}` or `{linkId}`. Each parameter is named once.

Two keys that differ only in a parameter's name, such as `{id}` and `{todoId}`, are the same route.
The SDK refuses them. Two keys that can match one request, such as `GET /v1/todos/{id}` and
`GET /v1/todos/archived`, are accepted. See [Routing](/flex-platform/domains/requests/#routing).

## Routes

| Field | Required | Rule |
|---|---|---|
| `handler` | Yes | Annotated with this route's key: see [Handlers](#handlers) |
| `operationId` | No | The route's name in the OpenAPI document, for a generated client. Camel case, such as `getTodo`, and unique across the domain |
| `description` | No | What the route does, shown in the OpenAPI document. Not blank |
| `params` | When the key has parameters | A Zod object with exactly the key's parameters: see [Path and query fields](#path-and-query-fields) |
| `query` | No | A [strict](#strict-inputs) Zod object: see [Path and query fields](#path-and-query-fields) |
| `body` | No | A [strict](#strict-inputs) Zod schema. Refused on `GET` and `DELETE` |
| `responses` | Yes | A Zod schema, or `null` for no body, for each status the route answers with: see [Responses](#responses) |

A route declares no headers, because the Frontdoor forwards only the
[headers it signs](/flex-platform/frontdoor/lambda-edge/#signing).

### Path and query fields

A path or query parameter arrives as text. Before the schema validates it, the SDK converts it to
the type its field declares. So each field's type must say how to read it:

| Field | Path | Query |
|---|---|---|
| A string, number or boolean, a string format such as `z.uuid()`, or an enum or literal of one of those types | Yes | Yes |
| An array of one of those | No | Yes |
| Optional, or with a default | No: a path parameter is always in the path | Yes |
| Nullable, an object, a union, a date, or a transform | No | No |

A field may carry refinements, which check a value without changing it.

The SDK reads each value strictly. It converts only text written in the one way its type is
written. Anything else stays text, and the schema refuses it:

- a number is a plain decimal: `-12`, `0` or `2.5`, not `+7`, `007`, `1e3`, `0x10`, `.5`, `-0` or
  `Infinity`. A whole number past 2<sup>53</sup> has no exact double, so it stays text;
- a boolean is `true` or `false`, in lower case;
- a string is the text as it is.

A query parameter sent once is one value. A query parameter sent more than once is a list. A field
declared as an array takes either as a list. Any other field takes one value, so it refuses a
parameter sent twice. The strict object refuses a parameter that the schema doesn't declare.

### Strict inputs

Every object in `query` and `body` that names its fields must refuse any other field, at any
depth. Use `z.strictObject` or `.strict()`. This matters because an input can be loosened later,
but never tightened without breaking a caller. An object that names no field stays open, and so
does each side of an intersection. Responses need not be strict.

No input may convert its value before checking it. The SDK refuses `z.coerce`, `z.stringbool()` and
`z.preprocess` in `params`, `query` and `body`, because they accept far more than they appear to.
For example, they read an empty string as 0. A transform after the check is kept in `body`.

### Responses

A route declares every status it answers with, a failure of its own as well as a success:

```ts
responses: { 200: TodoSchema, 404: TodoErrorSchema }
```

| Status | Takes |
|---|---|
| 200, 201, 202 | A schema, or `null` for no body |
| 204 | `null` only |
| 400, 404, 409, 410, 422, 429 | A schema of the domain's own, or `null`. The SDK gives a failure's body no shape |

A route may declare any status that a handler decides from the request it is given. The SDK
refuses every other status:

- 401 and 403, because the app reads either as an
  [expired token](/flex-platform/frontdoor/cloudfront-function/#rejections) and sends the request
  again;
- those about the request's method, length or media type, such as 405, 413 and 415, because the
  SDK or API Gateway answers them, so a route's own would read as the platform's;
- those that need a header the Frontdoor doesn't forward or a handler can't set, such as 206 and
  412, and WebDAV's;
- a 5xx status: [any handler](#handlers) may return a 500, 502, 503 or 504, and no route declares
  one.

## Handlers

Annotate each handler with its route's key. The type finds the route through the `Register`
declaration:

```ts
// src/routes/get-todo.ts
import type { Handler } from "@govuk-once/flex-domain-sdk";
import { notFound } from "@govuk-once/flex-domain-sdk";

import { findTodo } from "../todos.ts";

export const getTodo: Handler<"GET /v1/todos/{id}"> = ({ params, log }) => {
  const todo = findTodo(params.id);

  if (todo === undefined) {
    log.info("todo not found");

    return notFound({
      error: { code: "todo_not_found", message: "No such todo" },
    });
  }

  return { status: 200, body: todo };
};
```

The type gives a handler the [context](/flex-platform/domains/requests/#the-handlers-context) its
route declares, and nothing else. A handler returns either:

- one of the route's `responses` as `{ status, body }`, with the body typed by its schema's input;
- a 500, 502, 503 or 504 with no body.

A handler may be `async`.

The SDK exports a function for each common failure. Each function returns the response written out.
For example, `notFound()` returns `{ status: 404 }`, and `notFound(body)` returns
`{ status: 404, body }`.

| Function | Status | Body |
|---|---|---|
| `badRequest`, `notFound`, `conflict`, `unprocessable`, `tooManyRequests` | 400, 404, 409, 422, 429 | The one the route declares for that status, or none |
| `internalError`, `badGateway`, `unavailable`, `gatewayTimeout` | 500, 502, 503, 504 | None |

Use `Handler<...>` as an annotation, not with `satisfies`. The compiler reports `satisfies` as a
circular reference. The compiler refuses a handler on its route's `handler` field if the handler
has no annotation, or is annotated with another route's key. A program registers one domain.

## The OpenAPI document

The SDK builds a domain's OpenAPI 3.1 document from its configuration alone, without running a
handler. The SDK
does not yet export anything a domain can build the document with.

The document describes the domain's routes and schemas, and the answers the SDK sends itself:

- **Each route as an operation.** The operation holds the route's `operationId` and `description`
  if it sets them, its path and query parameters, its body, and each response it declares. A
  parameter is required unless its field is optional or has a default.
- **What the SDK answers on every operation.** These are the SDK's
  [own answers](/flex-platform/domains/requests/#the-sdks-own-answers) on a route: 400, 500, 502
  and 504, plus 415 on a route with a body. They also include 503, the one server error that only a
  handler answers with. Each has the platform's failure body, `PlatformError`. If a route declares
  a 400 too, the body is `anyOf` the two. `oneOf` would refuse a route's body that also matches
  `PlatformError`. The 404 and 405 for a path or method that no route has belong to no operation,
  so the document does not describe them.

Publishing a domain's document is planned. A domain will upload it through an endpoint for its
metadata uploads, and an endpoint in the Frontdoor will serve the published documents. When a
document is published, the platform adds what it applies to every domain:

- the server;
- the access token;
- the Frontdoor's and API Gateway's answers.

The SDK's document leaves these out, so that the platform writes what it owns rather than accepting
it from a domain.

Each schema is described as Zod writes it in JSON Schema. A parameter or body is described as the
request is validated, and a response as it is sent. So a field with a default is optional in a body
and always there in a response.

A schema named with `.meta({ id })` becomes a component that every use refers to. It becomes two
components, `<id>` and `<id>Input`, if its input and output differ, or if a named schema it holds
becomes two. A recursive schema must be named, so that a client has a name for its type.

Building the document checks the configuration first. It then throws a `DomainConfigError` that
lists every schema it can't describe, each as `<field>: <problem>, <fix>`. It can't describe:

- a schema holding what JSON doesn't carry, such as `z.date()`, or a response with a transform;
- a recursive schema with no name;
- an id used for two different schemas, or holding a character other than letters, digits, `.`,
  `_` and `-`;
- a component name already taken, such as `PlatformError`, or an id `TodoInput` beside a `Todo`
  that is two.

## Errors

The compiler reports most broken rules on the field that broke them. `defineDomain` checks the
rest as `src/domain.ts` is imported:

- the domain's name;
- strict and unconverted inputs;
- path and query fields that can't be read from text;
- two keys for one route;
- an `operationId` used twice.

It also checks what the types hold, in case a configuration bypassed them. It throws a
`DomainConfigError` that lists every problem, each written as `<field>: <problem>, <fix>`:

```text
The domain's configuration is not valid:
  - name: invalid format, must be 1 to 32 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen
  - function: unknown field, must be one of: name, description, routes
  - routes["GET /v1/todos"].body: not allowed, a GET route takes no body
  - routes: duplicate routes, parameter names do not tell apart: "GET /v1/todos/{id}", "GET /v1/todos/{todoId}"
```

Anything that imports `src/domain.ts`, such as a domain's tests and its CI, fails on the same
problems.
