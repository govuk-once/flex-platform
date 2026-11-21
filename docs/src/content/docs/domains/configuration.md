---
title: Domain configuration
description: The fields of a domain's configuration, the rules each is held to, and how a handler is typed from it.
---

A domain declares its name and routes in `src/domain.ts`, with `defineDomain` from the
[domain SDK](/flex-platform/domains/overview/#domain-sdk). The SDK types each handler from it and
checks it as it loads. The platform reads nothing from it, and sets the
[function's settings](/flex-platform/domains/hosting/#the-domains-function) itself.

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
| `routes` | At least one route, keyed by its [route key](#route-keys) |

## Route keys

A route key has the format `<METHOD> /<version>/<path>`, such as `GET /v1/todos/{id}`:

- the method is `GET`, `POST`, `PUT`, `PATCH` or `DELETE`;
- the path starts with a version, such as `/v1`, followed by at least one segment;
- a segment is lowercase letters, digits and hyphens, starting with a letter, or a path parameter
  in camel case, such as `{id}` or `{linkId}`.

The path is what the domain's function sees, after the Frontdoor
[removes the domain's segment](/flex-platform/frontdoor/lambda-edge/#routing). Two keys that differ
only in a parameter's name, such as `{id}` and `{todoId}`, are the same route, and are refused.

## Routes

| Field | Required | Rule |
|---|---|---|
| `handler` | Yes | Annotated with this route's key: see [Handlers](#handlers) |
| `params` | When the key has parameters | A Zod object with exactly the key's parameters, each taking a string |
| `query` | No | A strict Zod object, each field taking a string, or a list of strings when repeated |
| `body` | No | A strict Zod schema. Refused on `GET` and `DELETE` |
| `responses` | Yes | A Zod schema, or `null` for no body, for each status the route answers with: see [Responses](#responses) |

A route has no name, and no headers: the Frontdoor forwards only the
[headers it signs](/flex-platform/frontdoor/lambda-edge/#signing).

### Responses

A route declares every status it answers with, a failure of its own as well as a success:

```ts
responses: { 200: TodoSchema, 404: TodoErrorSchema }
```

- a 2xx status takes a schema, or `null` for no body. 204 and 205 take `null` only;
- a 4xx status takes a schema of the domain's own, or `null`. The SDK gives a failure's body no
  shape;
- 401 and 403 are refused, because the app reads either as an
  [expired token](/flex-platform/frontdoor/cloudfront-function/#rejections) and sends the request
  again;
- a 5xx status is refused. A failure that is not the route's own, such as a gateway that did not
  answer, is a 500, 502, 503 or 504, which [any handler](#handlers) may answer with and no route
  declares.

### Strict inputs

Every object in `query` and `body` that names its fields must refuse others, at any depth: use
`z.strictObject` or `.strict()`. An input can be loosened later, but never tightened without
breaking a caller. An object that names no field, and each side of an intersection, stay open.
Responses need not be strict.

## Handlers

Each handler is annotated with its route's key, which it finds through the `Register` declaration:

```ts
// src/routes/get-todo.ts
import type { Handler } from "@govuk-once/flex-domain-sdk";
import { notFound } from "@govuk-once/flex-domain-sdk";

import { findTodo } from "../todos.ts";

export const getTodo: Handler<"GET /v1/todos/{id}"> = ({ params }) => {
  const todo = findTodo(params.id);

  if (todo === undefined) {
    return notFound({
      error: { code: "todo_not_found", message: "No such todo" },
    });
  }

  return { status: 200, body: todo };
};
```

Its context holds the `params`, `query` and `body` its route declares, each typed by its schema's
output. It answers with one of the route's `responses` as `{ status, body }`, a failure the same
way as a success, and may be `async`. On any route it may also answer with a 500, 502, 503 or
504, which has no body of the handler's.

The SDK exports a function for each common failure, which returns the response written out:
`notFound()` is `{ status: 404 }`, and `notFound(body)` is `{ status: 404, body }`.

| Function | Status | Body |
|---|---|---|
| `badRequest`, `notFound`, `conflict`, `unprocessable`, `tooManyRequests` | 400, 404, 409, 422, 429 | The one the route declares for that status, or none |
| `internalError`, `badGateway`, `unavailable`, `gatewayTimeout` | 500, 502, 503, 504 | None |

Use `Handler<...>` as an annotation, not with `satisfies`, which the compiler reports as a circular
reference. A program registers one domain.

## Errors

The compiler reports most broken rules on the field that broke them. `defineDomain` checks the
rest as `src/domain.ts` is imported, such as the domain's name, strict inputs and two keys for one
route, and throws a `DomainConfigError` listing every problem. Each names the field, what is
wrong with it, and what it accepts where that is short:

```text
The domain's configuration is not valid:
  - name: "Domain_A" must be 1 to 32 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen
  - function: is not a domain field; accepted fields: name, routes
  - routes["GET /v1/todos"].body: must be left out, as a GET route takes no body
  - routes: these keys match the same requests, because a path parameter's name does not distinguish routes: "GET /v1/todos/{id}", "GET /v1/todos/{todoId}"
```
