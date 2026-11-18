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
| `responses` | Yes | A Zod schema, or `null` for no body, for each 2xx status. 204 and 205 take `null` only |
| `errors` | No | The codes the handler may reject with: `invalid_request`, `forbidden`, `not_found`, `conflict` or `unprocessable` |

A route has no name, and no headers: the Frontdoor forwards only the
[headers it signs](/flex-platform/frontdoor/lambda-edge/#signing). A failure is a code in `errors`,
never a status in `responses`.

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

export const getTodo: Handler<"GET /v1/todos/{id}"> = ({ params }) => ({
  status: 200,
  body: { id: params.id, title: "A todo", done: false },
});
```

Its context holds the `params`, `query` and `body` its route declares, each typed by its schema's
output, and `reject(code)`. `reject` takes the route's `errors`, and `internal`, `bad_gateway`,
`unavailable` or `timeout`, which any handler may use. It answers with one of the route's
`responses` as `{ status, body }`, or with what `reject` returned, and may be `async`.

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
