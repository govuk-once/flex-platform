---
title: Domain configuration
description: The fields of a domain's configuration, the rules each is held to, and how a handler is typed from it.
---

A domain declares its name and routes in `src/domain.ts`, with `defineDomain` from the
[domain SDK](/flex-platform/domains/overview/#domain-sdk). The SDK types each handler from it,
checks it as it loads, and uses it to [answer requests](/flex-platform/domains/requests/) and build
the domain's [OpenAPI document](/flex-platform/domains/overview/#api-specifications).

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

A route key has the format `<METHOD> /<version>/<path>`, such as `GET /v1/todos/{id}`:

- the method is `GET`, `POST`, `PUT`, `PATCH` or `DELETE`;
- the path starts with a version, such as `/v1`, followed by at least one segment;
- a segment is lowercase letters, digits and hyphens, starting with a letter, or a path parameter
  in camel case, such as `{id}` or `{linkId}`, named once.

Two keys that differ only in a parameter's name, such as `{id}` and `{todoId}`, are the same route,
and are refused. Two keys that can match one request, such as `GET /v1/todos/{id}` and
`GET /v1/todos/archived`, are accepted: see [Routing](/flex-platform/domains/requests/#routing).

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

A route declares no headers: the Frontdoor forwards only the
[headers it signs](/flex-platform/frontdoor/lambda-edge/#signing).

### Path and query fields

A path or query parameter arrives as text, and the SDK reads it by the type its field declares
before the schema validates it. So each field's type must say how to read it:

| Field | Path | Query |
|---|---|---|
| A string, number or boolean, a string format such as `z.uuid()`, or an enum or literal of one of those types | Yes | Yes |
| An array of one of those | No | Yes |
| Optional, or with a default | No: a path parameter is always in the path | Yes |
| Nullable, an object, a union, a date, or a transform | No | No |

A field may carry refinements, which check a value without changing it.

Each value is read strictly. Only text written the one way its type is written is converted, and
anything else stays text, for the schema to refuse:

- a number is a plain decimal: `-12`, `0` or `2.5`, not `+7`, `007`, `1e3`, `0x10`, `.5`, `-0` or
  `Infinity`. A whole number past 2<sup>53</sup>, which has no exact double, stays text;
- a boolean is `true` or `false`, in lower case;
- a string is the text as it is.

A query parameter sent once is one value, and sent more than once a list. A field declared as an
array takes either as a list. Any other field takes one value, so a parameter sent twice is refused.
A parameter the schema doesn't declare is refused by the strict object.

### Strict inputs

Every object in `query` and `body` that names its fields must refuse others, at any depth: use
`z.strictObject` or `.strict()`. An input can be loosened later, but never tightened without
breaking a caller. An object that names no field, and each side of an intersection, stay open.
Responses need not be strict.

No input converts its value before checking it: `z.coerce`, `z.stringbool()` and `z.preprocess`
are refused in `params`, `query` and `body`, since they accept far more than they appear to, such
as an empty string read as 0. A transform after the check is kept in `body`.

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

A route may declare each status a handler decides from the request it is given. Every other status
is refused:

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

Each handler is annotated with its route's key, which it finds through the `Register` declaration:

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
route declares, and nothing else. A handler returns one of the route's `responses` as
`{ status, body }`, with the body typed by its schema's input, or a 500, 502, 503 or 504 with no
body. It may be `async`.

The SDK exports a function for each common failure, which returns the response written out:
`notFound()` is `{ status: 404 }`, and `notFound(body)` is `{ status: 404, body }`.

| Function | Status | Body |
|---|---|---|
| `badRequest`, `notFound`, `conflict`, `unprocessable`, `tooManyRequests` | 400, 404, 409, 422, 429 | The one the route declares for that status, or none |
| `internalError`, `badGateway`, `unavailable`, `gatewayTimeout` | 500, 502, 503, 504 | None |

Use `Handler<...>` as an annotation, not with `satisfies`, which the compiler reports as a circular
reference. A handler with no annotation, or one annotated with another route's key, is refused on
its route's `handler`. A program registers one domain.

## Errors

The compiler reports most broken rules on the field that broke them. `defineDomain` checks the
rest as `src/domain.ts` is imported, and throws a `DomainConfigError` listing every problem: the
domain's name, strict and unconverted inputs, path and query fields that can't be read from text,
two keys for one route, and an `operationId` used twice. It checks what the types hold too, for a
configuration that bypassed them. Each problem is written as `<field>: <problem>, <fix>`:

```text
The domain's configuration is not valid:
  - name: invalid format, must be 1 to 32 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen
  - function: unknown field, must be one of: name, description, routes
  - routes["GET /v1/todos"].body: not allowed, a GET route takes no body
  - routes: duplicate routes, parameter names do not tell apart: "GET /v1/todos/{id}", "GET /v1/todos/{todoId}"
```

Whatever imports `src/domain.ts`, such as a domain's tests and its CI, fails on the same problems.
