# Domain SDK runtime: design and developer experience

Nov 23, 2026 · @Aron

## Scope

`@govuk-once/flex-domain-sdk` is the only package a domain needs to declare its routes, type its handlers and serve its requests. It has no web framework and no runtime dependency beyond its peers. It has two consumers:

- **The Flex platform** deploys each domain as one Lambda function behind one API Gateway REST API. The SDK turns that function's proxy event into a call to the right handler, and never answers in a way the platform forbids.
- **Domain repositories** each install a pinned SDK version and build one domain, in isolation from every other domain. A program registers exactly one domain. Domains share no code, state or configuration through the SDK.

The SDK guarantees:

1. Every route a domain serves is declared once, in `src/domain.ts`, with schemas for its inputs and its responses.
2. A handler runs only with inputs that passed their schemas, and only returns statuses its route declares, or a server error.
3. No response is ever 401 or 403.
4. Every gateway call a handler makes carries the caller token and the request's deadline.
5. Nothing from a request, a response or an error message is ever logged by the SDK.
6. The configuration alone produces the domain's OpenAPI document, without running a handler.

## Platform contract

The platform fixes how a domain's function runs and what reaches it. The SDK is built to these facts.

| Fact | Value | What the SDK does with it |
| --- | --- | --- |
| Runtime | `nodejs24.x`, arm64, 1,024 MB | Targets Node 24; uses `Request`, `Response`, `AbortSignal` and `Error.isError` |
| Handler | `index.handler` in the bundle's `index.js` | The domain exports `handler = createLambdaHandler(domain)` |
| Timeout | 29 seconds | The deadline is Lambda's remaining time minus 500 ms |
| Event | API Gateway REST API proxy event, payload format 1.0 | Read by the Lambda adapter only |
| Path | The request path after the Frontdoor removes `/app/<domain>`, for example `/v1/hello/Ada` | Route keys start at the version |
| `x-flex-secure` | The caller token, signed by the Frontdoor, present on every request | Read for `pairwiseId` and `pushId` and passed to gateways; never verified |
| Frontdoor host | `<environment>.flex-domainedge.once.service.gov.uk`, public paths `/app/<domain>/...` | Written into the OpenAPI document's server URL |
| `x-correlation-id` | `1-<8 hex>-<24 hex>` | Sent back on every response; logged as `traceId` |
| `FLEX_ENVIRONMENT` | Set on the function by a release | Read by the gateway client, never by the SDK |
| 401 and 403 | The app treats either as an expired token and retries | Never sent, by any path |
| Failure bodies | `{ "message": "...", "type": "..." }`; the app reads only the status | Used for every answer the SDK writes itself |
| Gateways | Invoked through `@govuk-once/flex-gateway-client` inside `withCallerContext` | Every handler runs inside that context |

## Package

The SDK has four entry points, so a Lambda bundle includes only the runtime it uses.

| Entry | Exports | Used by |
| --- | --- | --- |
| `@govuk-once/flex-domain-sdk` | `defineDomain`, `DomainConfigError`, `Handler`, `Register`, `Caller`, `Log`; `badRequest`, `notFound`, `conflict`, `unprocessable`, `tooManyRequests`, `internalError`, `badGateway`, `unavailable`, `gatewayTimeout`; `createServe`, `Serve`, `ServeOptions`; `createLambdaHandler` | `src/domain.ts`, handlers, the function's entry |
| `…/testing` | `createTestClient` | A domain's tests |
| `…/local` | `serveLocally` | A domain's local dev script |
| `…/openapi` | `buildOpenApiDocument`, `OpenApiDocument` | A domain's CI, and the platform's push flow |

| Dependency | Kind | Reason |
| --- | --- | --- |
| `zod` `^4` | Peer | The domain's schemas and the SDK must share one copy |
| `@govuk-once/flex-gateway-client` | Peer, required | One copy of the caller context for the SDK and the domain's gateway calls |
| `@aws-sdk/client-lambda` | Peer of the gateway client | Installed by the domain and bundled into its function |
| `@repo/utils`, `@repo/cloudfront-js-utils` | Workspace, bundled | Never published separately |

Publishing:

- Built with rolldown to ESM with `.d.ts`, `sideEffects: false`, `dependencies: {}`.
- Published to GitHub Packages under `@govuk-once` through the platform's release process (`@repo/release`, `releases.json`).
- Versioned by semver chosen at release. A breaking change to the configuration's types or the runtime's answers is a major version.

## Configuration

A domain's configuration is `defineDomain({ name, routes })` in `src/domain.ts`, registered through `Register`. The compiler checks what types can express. `defineDomain` checks the rest as the module loads, and throws one `DomainConfigError` listing every problem as `<field>: <rule broken>; <what is accepted>`.

### Domain

| Field | Rule |
| --- | --- |
| `name` | 1 to 32 lowercase letters, digits and hyphens; starts with a letter; does not end with a hyphen |
| `description` | Optional; not blank when given. The OpenAPI document's `info.description` |
| `routes` | At least one route, keyed by route key |

### Route keys

`<METHOD> /v<n>/<segment>/...`

- `METHOD` is `GET`, `POST`, `PUT`, `PATCH` or `DELETE`.
- The path starts with a version (`/v1`) and has at least one more segment.
- A segment is lowercase letters, digits and hyphens starting with a letter, or a camel-case parameter such as `{id}`.
- A parameter name appears once per key.
- Two keys that differ only in a parameter's name are refused. A literal segment and a parameter at the same position are both allowed (see Routing rules).

### Routes

| Field | Required | Rule |
| --- | --- | --- |
| `handler` | Yes | A function typed `Handler<"<its key>">` |
| `operationId` | All or none | The operation's name in the OpenAPI document: a lowercase letter, then letters and digits. Set on every route or on none; unique |
| `description` | No | Not blank when given. The operation's `description` in the OpenAPI document |
| `params` | When the key has parameters | A Zod object with exactly the key's parameters; each field a string, number or boolean type, never optional |
| `query` | No | A strict Zod object; each field a string, number or boolean type, or a list of one for a repeated parameter; optional or defaulted allowed |
| `body` | No | A strict Zod schema; refused on `GET` and `DELETE` |
| `responses` | Yes | At least one status, each a Zod schema or `null` |
| `log` | No | `{ input?, output? }`: dot paths to scalar fields to log (see Logging) |

Inputs (`query`, `body`) are strict at every depth: each object that names its fields uses `z.strictObject` or `.strict()`. No input converts its value before checking it: `z.coerce`, codecs such as `z.stringbool()`, and `z.preprocess` are refused. A transform after a schema has checked the value (`z.iso.datetime().transform(...)`) is the domain's own, and is kept in a body; a path or query field takes a plain type only.

A developer writes the type a field means (`z.number()`, `z.boolean()`, `z.enum([...])`, `z.array(...)` for a repeated query parameter), as in a body. The SDK reads each path and query value from its text by that declared type, before the schema validates it (see Request pipeline). The handler's context is typed from each schema's output.

Every refusal message, at load and in the types, describes the rule without naming a library or its API, so replacing Zod doesn't mean rewriting messages: "must be a schema", "must refuse fields it does not declare", "converts its input before checking it; declare the type it takes instead".

### Responses

| Status | Body | Declared by the route |
| --- | --- | --- |
| 200, 201, 202, 203, 206, 207, 208, 226 | A schema, or `null` | Yes |
| 204, 205 | `null` only | Yes |
| 400, 402, 404, 409, 410, 412, 413, 422, 423, 424, 425, 428, 429, 451 | A schema of the domain's own, or `null` | Yes |
| 401, 403 | — | Refused: the app reads either as an expired token |
| 405, 406, 407, 408, 411, 414, 415, 416, 417, 421, 426, 431 | — | Refused: protocol statuses the SDK or API Gateway answer |
| 500, 502, 503, 504 | None from the handler; the SDK writes the platform body | Refused: any handler may return them |

The allowed sets are `SUCCESS_STATUS_CODES`, `FAILURE_STATUS_CODES` and `SERVER_ERROR_STATUS_CODES` in `http.ts`. The refusal messages for 401/403 and for protocol statuses each say why.

### Handlers

```ts
export const getTodo: Handler<"GET /v1/todos/{id}"> = async ({ params, caller, signal, log }) => {
  const todo = await findTodo(params.id, { signal });
  if (todo === undefined) log.info("todo not found");
  return todo === undefined ? notFound({ code: "todo_not_found" }) : { status: 200, body: todo };
};
```

- Annotate with `Handler<Key>`. `satisfies` is refused, because the compiler reports a circular reference.
- **Context:** `params`, `query` and `body` as each declared schema's output, plus `caller: { pairwiseId, pushId }`, `signal: AbortSignal`, which aborts at the deadline, and `log` (see Logging).
- **Result:** `{ status, body }` for a declared status, with `body` the schema's input (none for `null`), or `{ status: 500 | 502 | 503 | 504 }` with no body. It may be async.
- **Helpers** return the result written out: `notFound()` is `{ status: 404 }`; `notFound(body)` is `{ status: 404, body }`. Route failures: `badRequest`, `notFound`, `conflict`, `unprocessable`, `tooManyRequests`. Server errors: `internalError`, `badGateway`, `unavailable`, `gatewayTimeout`.
- **One file per handler** under `src/routes/`, imported by `src/domain.ts`.

## Routing rules

Routing is done by `routeMatcher` in `@repo/utils/route-matcher`. It matches a method and path to a route, and dispatches nothing. Routes are compiled once, when the function's module loads.

1. A path matches a route when it has the same number of segments, each literal is equal (case-sensitive), and each parameter segment is non-empty.
2. Where several routes with the request's method match, the one with a literal segment wins at the first segment where their paths differ. `GET /v1/todos/archived` beats `GET /v1/todos/{id}` for `/v1/todos/archived`.
3. No route matches the path for any method → 404.
4. Some route matches the path, none for the method → 405, with `Allow` listing the path's methods in declared order.
5. HEAD and OPTIONS are methods like any other: undeclared, so 405.
6. The router never decodes. The runtime decodes each path parameter once (`decodeURIComponent`). A parameter that fails to decode, or decodes to text containing `/`, is a 400.
7. Two routes with the same method whose paths differ only in parameter names fail at compile.

Implementation: each compiled route has a rank, one `L` (literal) or `P` (parameter) per segment. The matcher walks the routes in declared order, keeps the matching route for the method with the lowest rank by code unit (`L` < `P`), and collects the other methods for `Allow` in declared order. No sort.

```ts
export interface Routable { readonly method: string; readonly path: string }
export type RouteMatch<Route extends Routable> =
  | { readonly kind: "route"; readonly route: Route; readonly params: ReadonlyMap<string, string> }
  | { readonly kind: "method"; readonly allowed: readonly string[] }
  | { readonly kind: "none" };
export function routeMatcher<Route extends Routable>(routes: readonly Route[]): (method: string, path: string) => RouteMatch<Route>;
```

New code, starting from `shared/ci/src/function/router.ts`, which already matches whole segments, refuses an empty parameter, collects 405 methods and refuses colliding routes. Parameter names follow the SDK's route keys (`[a-z][a-zA-Z0-9]*`). Moving the CI Lambda onto it, keeping its own rule that every path names `{environment}` and `{domain}` in a wrapper, is a separate refactor.

## Request pipeline

`createServe(domain)` returns `serve(request: Request, { remainingTimeMs }): Promise<Response>`. It runs these steps in order, and the first that answers ends the request. Nothing throws out of `serve`: an unexpected error is a 500.

1. **Trace ID:** take `x-correlation-id` only if it has the Frontdoor's form. Set it on the final response.
2. **Caller:** read `x-flex-secure` as a JWT payload with a non-empty `pairwiseId` and `pushId`. Missing or unreadable → 500, for every path: this runs before routing, as the gateway and the Frontdoor check the token before routing. No request reaches a deployed domain without the token, so a missing one is a platform fault, and every request shows it.
3. **Route:** `match(method, url.pathname)` → 404, 405, or a match.
4. **Body text:** read once, for every route.
5. **Query:** `URLSearchParams` → a map of `string | string[]`, a repeated name as a list → the route's parameter reader → `route.query.safeParse` → 400 on failure. A route with no `query` refuses any query string with a 400, as a bodiless route refuses a body.
6. **Path parameters:** decode → the route's parameter reader → `route.params.safeParse` → 400 on failure.

The parameter reader is built once per route, from `parameterTypes(schema, location)`, the same function `checkDomain` reports problems from. It converts a value from text only when the text is written the one way its declared type is written, and leaves anything else as text for the schema to refuse:

- a number: a plain decimal, with no sign but `-`, no leading zero, no exponent, no space; a whole number outside the safe integer range, and `-0`, stay text (as openapi-rest's `metadata.ts` reads a header);
- a boolean: exactly `true` or `false`;
- a list field: one value becomes a list of one; any other field given a list keeps it, for the schema to refuse.
7. **Body**, when not declared: a non-empty body → 400 (an empty one, or a `content-type` with none, is fine), so declaring a body later loosens the route rather than tightening it. When declared: empty → 400; content type not `application/json` (parameters allowed) → 415; `JSON.parse` fails → 400; `route.body.safeParse` fails → 400.
8. **Handler:** `deadline = now + remainingTimeMs − 500`. Run `handler({ params, query, body, caller, signal, log })` inside `withCallerContext({ deadline, secure: { token } })`, raced against the deadline. Past the deadline → abort `signal`, 504.
9. **Result:** check what the handler returned (see Responses). The body sent is the schema's **output**, so fields the schema does not declare never leave.

```text
 Request ─▶ trace ─▶ caller ─▶ route ─▶ query ─▶ params ─▶ body ─▶ handler ─▶ result ─▶ Response
                       │        │         │         │        │         │          │
                      500    404/405     400       400   400/415   504/502/500   500
                           (every refusal: platform body, x-rejected-by: domain, one log line)
```

## Responses

A domain's API sends three kinds of answer: the route's own, a handler's server error, and the SDK's own. Only the SDK's own carry `x-rejected-by: domain`. Every response carries `x-correlation-id` when the request had a valid one, and every response with a body carries `content-type: application/json`. No path ever answers 401 or 403.

The platform bodies below are defined in the SDK, matching the Frontdoor's where it answers the same status. Bringing every workspace's rejection bodies into one catalogue is a later refactor.

| Answer | Status | Body | `x-rejected-by` |
| --- | --- | --- | --- |
| Declared response | Any declared 2xx or 4xx | Schema output, or empty for `null` | — |
| Handler server error | 500, 502, 503, 504 | Platform body | — |
| No readable caller token | 500 | Platform body | `domain` |
| No route for the path | 404 | Platform body | `domain` |
| No route for the method | 405, with `Allow` | Platform body | `domain` |
| Invalid query, path, body or JSON; missing body; a body on a route that takes none | 400 | Platform body | `domain` |
| Body not `application/json` | 415 | Platform body | `domain` |
| Handler past the deadline | 504 | Platform body | `domain` |
| Gateway call failed and the handler let it through | `timed_out` → 504; `function_error`, `invalid_response` → 502; `invoke_failed`, `aborted` → 500 | Platform body | `domain` |
| Handler throws; returns an undeclared status (including 401 or 403), a body its schema refuses, a body for a `null` status, a body with a server error, or no result | 500 | Platform body | `domain` |

Platform bodies:

| Status | `type` | `message` |
| --- | --- | --- |
| 400 | `client_error` | `Bad request` |
| 404 | `client_error` | `Not found` |
| 405 | `client_error` | `Method not allowed` |
| 415 | `client_error` | `Unsupported media type` |
| 500 | `server_error` | `Internal server error` |
| 502 | `server_error` | `Bad gateway` |
| 503 | `server_error` | `Service unavailable` |
| 504 | `server_error` | `Gateway timeout` |

A route that takes input and declares 400 can send either its own 400 body (from its handler) or the platform's (from the SDK). The OpenAPI document describes both.

## Adapters

Each adapter turns its input into a `Request`, calls `serve`, and turns the `Response` back. `serve` knows nothing about Lambda, tests or sockets.

### Lambda: `createLambdaHandler(domain)`

`createLambdaHandler(domain)` returns `(event, context) => Promise<ProxyResult>`. It compiles the routes when it is called, at module load.

| From the event | To the `Request` |
| --- | --- |
| `httpMethod` | `method` |
| `path` + `multiValueQueryStringParameters` | URL `https://domain.invalid` with its path built segment by segment, each encoded, never by joining strings, and each query value appended |
| `multiValueHeaders` | `Headers`, each value appended (names case-insensitive) |
| `body` + `isBase64Encoded` | Body text or bytes; none for `GET` and `HEAD` |
| `context.getRemainingTimeInMillis()` | `remainingTimeMs` |

The result is `{ statusCode, headers: Object.fromEntries(response.headers), body: await response.text(), isBase64Encoded: false }`.

Joining `path` into a URL string is unsafe: `URL` removes `..` and `%2e%2e`, turns `\` into `/`, and, if API Gateway hands `path` over decoded, a `%3F` the Frontdoor let through would start a query. Whether `path` arrives decoded, and so whether the runtime's decode is a second one, is confirmed from a real event before `requestFrom` is written.

`createLambdaHandler` also replaces `console`'s methods as the function loads (see Logging).

### Testing: `createTestClient(domain, options?)`

```ts
const client = createTestClient(domain, { caller: { pairwiseId: "user-a" }, remainingTimeMs: 10_000 });
await client.get("/v1/todos/1");
await client.post("/v1/todos", { title: "Book a test" });     // JSON body, content type set
await client.request(new Request("https://domain.invalid/v1/todos", { method: "DELETE" }));
```

- It builds an unsigned caller token from `caller` (default `{ pairwiseId: "test-user", pushId: "test-push-id" }`), sets `x-flex-secure` on every request, `request` included, unless the request already has one, and calls `serve`.
- It has `get`, `delete`, `post`, `put` and `patch` (the last three take an optional JSON body), and `request` for full control.
- It returns the `Response` unchanged.
- It writes no log line unless given `onLog`, which receives each line as JSON text.

### Local: `serveLocally(domain, port = 3000)`

A `node:http` server that turns each incoming request into a `Request`, adds a stand-in caller token when `x-flex-secure` is absent, and writes the `Response` back. `remainingTimeMs` is 29,000. Gateway calls need `FLEX_ENVIRONMENT`, plus `AWS_ENDPOINT_URL_LAMBDA` pointing at a stand-in for Lambda's API.

## OpenAPI document

`buildOpenApiDocument(domain, { version, title? })` returns an OpenAPI 3.1 document of the domain's public API, as a client calling it through the Frontdoor meets it: exactly the declared routes, the SDK's own answers, and the Frontdoor's. It reads the configuration only and calls no handler. Schemas come from `z.toJSONSchema(schema, { target: "draft-2020-12", io })`, with `$schema` removed.

The platform never sees a domain's configuration or document (the pipeline sends only the bundle), so there is no later step to add the Frontdoor's part. The SDK, run in the domain's CI, builds the whole document.

| Part | Source | Rule |
| --- | --- | --- |
| `servers` | The Frontdoor host pattern and the domain's name | `https://{environment}.flex-domainedge.once.service.gov.uk/app/<name>`, `environment` a free variable, default `development` (OpenAPI requires one; the least harmful target for a call nobody chose) |
| `security` | The Frontdoor | One bearer scheme, applied to every operation |
| Operation | Route key | `paths["/v1/todos/{id}"].get` |
| `operationId` | The route's `operationId` | Left out when the domain sets none |
| Path parameters | `params` | One per property of the input schema; `in: path`; `required: true` |
| Query parameters | `query` | One per property; `in: query`; `required` from the schema |
| Request body | `body` | `required: true`, `application/json`, `io: "input"` |
| Declared responses | `responses` | Schema with `io: "output"`; no `content` for `null`; description is the reason phrase |
| 400 | Every route | Platform body (a route with no query or body still refuses one); `oneOf` with the route's own 400 schema when declared (the Frontdoor's 400 for a query it can't sign is the same body) |
| 401 | Every route | The Frontdoor's `auth_error` body |
| 403 | Every route | No schema: WAF's own block |
| 413 | Route has `body` | Platform body: WAF refuses a body over 16 KB |
| 415 | Route has `body` | Platform body |
| 429 | Every route | Platform body: WAF's rate limits |
| 500, 502, 503, 504 | Every route | Platform body |
| `x-correlation-id` | Every response | Response header |
| Not described | — | 404 and 405 for unknown paths and methods |

- The platform body is `components.schemas.PlatformError`, referenced by `$ref`.
- `operationId` is optional in OpenAPI, and nothing in the platform reads it. Nothing is built from a route key. `checkDomain` refuses a domain that names some operations and not others, naming the routes without one, since a client generator would name those itself and the document would mix two styles. It also refuses two routes with the same id, naming both.
- `info.title` defaults to the domain's name; `info.version` is the caller's.
- A schema JSON Schema can't hold (such as a `z.date()` output or a transform's output) throws one `DomainConfigError` naming every failing route and status.
- The host pattern and the Frontdoor's bodies are defined in the SDK. Bringing them together with the other workspaces' copies (`infra/app`'s `zones.ts`, the Frontdoor's and WAF's bodies) is a later refactor.

## Logging

Logging follows the gateways: nothing from a request or response is logged unless named, and only scalars. There is no redaction by pattern.

Every line has the gateways' format: one JSON object on standard output, with the keys Pino writes by default (`level` as a number, `time`, `pid`, `hostname`, `name` as the domain's name, `msg`), then the line's fields. The first pass writes it with the SDK's own writer, behind a `LogSink` interface, so Pino can replace it in one module; a test writes the same entry through both and compares them. Which one stays is decided from working code.

**One line per request.** Every request gets exactly one line from the SDK, as each gateway invocation does. It holds what is known by the time the request ends: the route, the status, the duration and, once input passed, the fields the route's `log` picks. The message is fixed text. Its level says what happened:

| Level | When |
| --- | --- |
| `info` (30) | The handler returned a declared 2xx or 4xx |
| `warn` (40) | The SDK refused the request (400, 404, 405, 415, or 500 for a missing caller token); the handler returned a 5xx itself; the deadline passed (504); a gateway call failed and the handler let it through |
| `error` (50) | The handler's code is wrong: it threw something the SDK does not recognise (logged as frames only), or returned something its route does not allow (an undeclared status, a body its schema refuses, a body for a `null` status, no result) |

`error` means a developer must look at the code, as it does for the gateways, whose runtime logs a failure it understands at `warn` and only an unhandled one at `error`. It does not count failed requests: API Gateway's `5XXError` metric counts every 5xx. A handler adds context with `ctx.log`, which has no `error`, like the driver logger.

```json
{"level":40,"time":1795862400000,"pid":8,"hostname":"169.254.10.1","name":"example","msg":"request refused","traceId":"1-5759e988-bd862e3fe1be46a994272793","route":"POST /v1/todos","status":400,"durationMs":3,"part":"body"}
```

| Field | When | Holds |
| --- | --- | --- |
| `traceId` | When the request has a valid one | The trace ID |
| `route` | Once a route matched | The route key |
| `status` | Always | The status sent |
| `durationMs` | Always | Milliseconds from the request to the answer |
| `part` | Input refused | `query`, `params` or `body` |
| `reason` | Gateway failure let through | The `GatewayInvocationError` reason |
| `frames` | Handler threw | Source locations only, from `describeUnexpectedError` |
| `input`, `output` | The route's `log` names fields | The picked scalars |

**A route's payload fields.** A route's `log` names fields with the gateways' syntax: dot paths, `*` across a list's entries or an object's values, scalar leaves only.

```ts
log: { input: ["params.id", "query.page", "body.title"], output: ["id", "items.*.status"] }
```

- `input` reads `{ params, query, body }`, as validated. `output` reads the response body, whatever the status; a path the returned status's schema lacks resolves to nothing.
- `defineDomain` checks that every path names a scalar field its schema declares. (Gateways don't check: their configurations are reviewed here; a domain's aren't.)
- They go on the request's one line, under `input` and `output`. With no `log`, the line still goes, with neither.

**A handler's own lines.** `ctx.log`, with the driver logger's shape:

```ts
interface Log {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
}
```

- The message must be a string literal type: text built from a template or a variable is a type error.
- Fields are scalars; anything else is dropped. They go under their own key, `fields`, so none stands in for `msg` or `traceId`.
- The SDK adds `traceId` and `route`. A helper module takes `log` as an argument.

**Values never logged.** The caller token, `pairwiseId` and `pushId`. Both IDs are personal data, and the gateways and the Frontdoor never log the token's claims.

1. Run time: the SDK holds the request's own values. A field, or a value `log` picks, that equals or contains one is replaced, and a warning says where. Exact values, not patterns.
2. Types: `caller.pairwiseId` and `caller.pushId` are branded, and `ctx.log` refuses a field of either type.
3. Fixed messages, so neither can be written into one.

**`console`.** `createLambdaHandler` replaces `console`'s methods as the function loads. Each call writes one SDK line saying console output was dropped, with the method and the call's source locations, never its content. This covers third-party libraries too. The SDK's writer writes to standard output directly, so it is unaffected. The test client and `serveLocally` leave `console` alone, so a developer can debug. A lint rule against `console` for domain repositories gives earlier feedback.

The SDK never logs a value from a request, a response, a schema error or an error's message, beyond what a route's `log` names.

## Module layout

The SDK lives in `domains/sdk/src`, in four layers. Each layer depends only on the layers above it in this list.

```text
domains/sdk/src/
├── CONFIGURATION
│   ├── define-domain.ts     defineDomain: runs checkDomain, returns the config typed
│   ├── check-domain.ts      load-time rules, DomainConfigError
│   ├── refine.ts            type-level rules, Problem<...> messages
│   ├── handler.ts           Handler<Key>, Caller, RequestContext, RouteContext, RouteResult
│   ├── caller.ts            CallerValue, the brand a log refuses
│   ├── log.ts               Log, LogFields: a handler's log, typed
│   ├── register.ts          Register, RegisteredRoutes
│   ├── failures.ts          notFound() … gatewayTimeout()
│   ├── route-key.ts         parseRouteKey
│   ├── input-rules.ts       strictInputProblems, parameterTypes (replaces strict-input.ts)
│   ├── log-paths.ts         a route's log paths, checked against its schemas
│   ├── http.ts              methods, status sets, header names
│   └── types.ts             DomainConfig, RouteConfig, RouteLog
├── app/  RUNTIME
│   ├── serve.ts             createServe: the pipeline, one log line per request
│   ├── compile-route.ts     route key + config → CompiledRoute (Routable)
│   ├── request-input.ts     pathParameters, queryParameters, isJson, parseJson
│   ├── parameter-reader.ts  a value from its text, by its field's declared type
│   ├── caller-token.ts      x-flex-secure → { caller, token }
│   ├── log-writer.ts        LogSink, the JSON-line writer, handlerLog, callerValueGuard
│   ├── pick-fields.ts       what a route's log picks from input and output
│   ├── console.ts           console's methods replaced (used by the Lambda adapter)
│   ├── deadline.ts          runBeforeDeadline, ANSWER_MARGIN_MS = 500
│   ├── handler-result.ts    resultRules, answerResult
│   ├── invocation-failures.ts  GatewayInvocationError reason → status
│   └── responses.ts         platform bodies, refusal (x-rejected-by)
├── lambda/rest-api.ts  ADAPTERS   createLambdaHandler, requestFrom, resultFrom
├── testing/index.ts               createTestClient, testCallerToken
├── local/index.ts                 serveLocally
├── openapi/document.ts  DESCRIPTION  buildOpenApiDocument
└── index.ts                       the main entry's exports

packages/utils/src/route-matcher.ts   routeMatcher (@repo/utils/route-matcher)
```

## A domain repository

Every domain repository has the same shape. `govuk-once/flex-platform-domain-sandbox`, the `example` domain, is the reference.

```text
<domain-repo>/
├── .npmrc                    @govuk-once scope → GitHub Packages
├── pnpm-workspace.yaml       minimumReleaseAgeExclude: ["@govuk-once/*"]
├── package.json              SDK, gateway client, client-lambda, zod: pinned exactly
└── src/
    ├── domain.ts             defineDomain + Register
    ├── domain.test.ts        tests through createTestClient
    ├── schemas.ts            Zod schemas
    ├── version.ts            the version esbuild writes in
    ├── routes/<route>.ts     one Handler<Key> per file
    ├── function/handler.ts   export const handler = createLambdaHandler(domain)
    ├── local.ts              serveLocally(domain)
    ├── build/                esbuild → one CommonJS index.js → deterministic zip
    └── ci/                   upload, release, wait for live
```

### Install

```ini
# .npmrc
@govuk-once:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```json
"dependencies": {
  "@aws-sdk/client-lambda": "<pinned>",
  "@govuk-once/flex-domain-sdk": "<pinned>",
  "@govuk-once/flex-gateway-client": "<pinned>",
  "zod": "<pinned>"
}
```

CI's checks job sets `NODE_AUTH_TOKEN` to its `GITHUB_TOKEN` with `packages: read`. Locally, a developer sets it to a personal token with `read:packages`.

### `src/domain.ts`

```ts
import { defineDomain } from "@govuk-once/flex-domain-sdk";

import { hello } from "./routes/hello.ts";
import { helloName } from "./routes/hello-name.ts";
import { ping } from "./routes/ping.ts";
import { GreetingSchema, NameParamsSchema } from "./schemas.ts";

const domain = defineDomain({
  name: "example",
  routes: {
    "GET /v1/hello": { handler: hello, responses: { 200: GreetingSchema } },
    "GET /v1/hello/{name}": { handler: helloName, params: NameParamsSchema, responses: { 200: GreetingSchema } },
    "GET /v1/ping": { handler: ping, responses: { 200: GreetingSchema } },
  },
});

export default domain;

declare module "@govuk-once/flex-domain-sdk" {
  interface Register {
    readonly domain: typeof domain;
  }
}
```

```ts
// src/schemas.ts
export const GreetingSchema = z.object({ message: z.string(), version: z.string() });
export const NameParamsSchema = z.object({ name: z.string().min(1).max(64) });

// src/version.ts
declare const FLEX_EXAMPLE_VERSION: string | undefined;
export const VERSION = typeof FLEX_EXAMPLE_VERSION === "string" ? FLEX_EXAMPLE_VERSION : "0.0.0-test";

// src/routes/hello-name.ts
export const helloName: Handler<"GET /v1/hello/{name}"> = ({ params }) => ({
  status: 200,
  body: { message: `Hello, ${params.name}, from the example domain`, version: VERSION },
});

// src/function/handler.ts
export const handler = createLambdaHandler(domain);
```

### `src/domain.test.ts`

```ts
const client = createTestClient(domain);

it("says hello by name", async () => {
  const response = await client.get("/v1/hello/Ada");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ message: "Hello, Ada, from the example domain", version: "0.0.0-test" });
});

it("answers unknown paths and methods itself", async () => {
  expect((await client.get("/v1/goodbye")).status).toBe(404);
  expect((await client.post("/v1/hello")).status).toBe(405);
});
```

### Build and release

- esbuild bundles `src/function/handler.ts` and every dependency into one CommonJS `index.js`, with `target: "node24"` and the version from `package.json` defined in.
- The zip holds `index.js` only. The pipeline uploads it under `package.json`'s `version` and releases it.
- Public URLs are `/app/<domain>/v<n>/...`; for the sandbox, `/app/example/v1/hello/Ada`.

## Tests

The SDK's tests run on Node 24 in CI. Each behaviour below has a named test.

| Area | Test file | Cases |
| --- | --- | --- |
| Status sets | `check-domain.test.ts`, `define-domain.test.ts` | 401 and 403 refused at load and in types, with their message; protocol statuses refused; 5xx refused; a type test pinning each message's list to its constant |
| Context and result types | `handler.test.ts` | Context has `caller` (`pairwiseId`, `pushId`), `signal`, `log` and exactly the declared parts; result is the declared statuses plus bodiless 5xx |
| Input rules | `input-rules.test.ts`, `refine` type tests | Open objects, coercion and pipes refused; each path and query field type accepted or refused, at load and in the types; messages name no library |
| Parameter reader | `app/parameter-reader.test.ts` | Decimals, leading zeros, exponents, spaces, `-0` and unsafe integers left as text; `true`/`false` only; one value into a list field; a list into a scalar field left for the schema |
| Route matcher | `packages/utils/src/route-matcher.test.ts` | Match, 404, 405 with `Allow` in declared order, literal beats parameter, collision at compile, parameters not decoded |
| Pipeline | `app/serve.test.ts` | Declared 2xx and 4xx; a non-empty body on a route without one → 400, an empty one accepted; null bodies; `content-type` on every body; handler 5xx with platform body and no `x-rejected-by`; 400 for each input part; 415; missing token → 500 on every path; handler returning 401 or 403 → 500; past the deadline → 504 and `signal` aborted; each `GatewayInvocationError` reason; caller context holds the token and deadline; response body is the schema output |
| Logging | `app/log.test.ts`, `app/serve.test.ts` | Line format matches Pino's for the same entry; exactly one SDK line per request, at `info` for a declared answer, `warn` for a refusal, a returned 5xx, a deadline or a gateway failure, and `error` for a throw or an answer the route does not allow; non-scalar fields dropped; route `log` paths checked at load and picked per request; the token, `pairwiseId` and `pushId` replaced wherever they appear; a secret in body, query, path or a thrown message never logged |
| Console | `app/console.test.ts` | Each method's output dropped, with one line naming the method and locations, never the content |
| Lambda | `lambda/rest-api.test.ts` | Base64 body, header case, repeated query names, no body on `GET`, result shape; a path with `..`, `\`, `?` or `#` in a segment reaches the matcher as sent |
| Testing client | `testing/index.test.ts` | Caller token, added to `request` too unless present; JSON bodies; each method |
| OpenAPI | `openapi/document.test.ts`, `check-domain.test.ts` | Exactly the declared operations; `operationId` set when every route names one, absent when none do; a malformed one, a domain naming only some, and two routes with the same id refused; validates as OpenAPI 3.1; servers, security and the Frontdoor's answers; 400 `oneOf`; an undescribable schema fails with the route |

## Work to do

The configuration layer exists in `domains/sdk`. Everything below is what remains, in delivery order.

### Configuration

- [x] `http.ts`: set `FAILURE_STATUS_CODES` to 400, 402, 404, 409, 410, 412, 413, 422, 423, 424, 425, 428, 429, 451. Add `PROTOCOL_STATUS_CODES` (405, 406, 407, 408, 411, 414, 415, 416, 417, 421, 426, 431). Add `MEDIA_TYPE_JSON`, `CALLER_TOKEN_HEADER`, `CORRELATION_ID_HEADER`, `REJECTED_BY_HEADER`.
- [x] `refine.ts`, `check-domain.ts`: refuse protocol statuses with their own message.
- [x] `handler.ts`: add `Caller` (`pairwiseId`, `pushId`, branded) and `RequestContext` (`caller`, `signal`, `log`); `RouteContextOf = RequestContext & RequestOf<Route>`. Update `handler.test.ts`.
- [ ] Delete `strict-input.ts` and `strict-input.test.ts`, which `input-rules.ts` replaces (Aron).
- [x] `input-rules.ts`: bring `temp/flex-533-domain-hono-openapi`'s across, with its tests, replacing `strict-input.ts`. Add `parameterTypes(schema, location)`, returning the types or the problems, for `checkDomain` and the reader alike. Leave behind its `check-domain.ts`, which still checks `errors`.
- [x] `refine.ts`: flip the parameter checks. A path field's input is a string, number or boolean; a query field's may also be a list of one; an `unknown` input (coercion) is refused.
- [x] Rewrite every refusal message to name no library: `check-domain.ts` (four), `strict-input.ts`'s, `refine.ts`'s two, and every new one.
- [x] `log` on a route, and `log-paths.ts`: paths checked against the schemas at load.
- [x] `operationId` on a route: `checkDomain` checks its form, all or none, and duplicates. Add it to the accepted fields in `refine.ts`'s `FieldCheck` message.

### Route matcher

- [x] `packages/utils/src/route-matcher.ts` (`@repo/utils/route-matcher`), `routeMatcher` with ranking and 404/405, plus its tests. Utils' wildcard export covers it.
- [ ] Later, separately: move `shared/ci/src/function/router.ts` onto it; CI tests pass unchanged.

### Runtime and adapters

- [x] `app/parameter-reader.ts`: bring it across, with its tests, and extend it. It takes the SDK's own map, not `unknown`, and builds its types with `parameterTypes`, with no throw of its own. Leave a whole number outside the safe integer range, and `-0`, as text. Remove the comments about Hono's validators and `z.preprocess`.
- [x] `app/`: `serve`, `compile-route`, `request-input`, `handler-result`, `responses`, `invocation-failures`. Take `caller-token.ts` (extended to `pushId`), `deadline.ts` and `report.ts`, with their tests, from `temp/flex-533-domain-hono-openapi`.
- [x] `app/log-writer.ts`: `LogSink`, the JSON-line writer in Pino's format, caller values replaced; `Log` typed in `log.ts`. Pino a devDependency for the format test, which matches it byte for byte.
- [x] `app/console.ts`: `console`'s methods replaced.
- [ ] Log one real proxy event from the sandbox first, to confirm whether `event.path` arrives decoded.
- [x] `lambda/rest-api.ts`: `createLambdaHandler`.
- [x] `testing/`: `createTestClient`.
- [x] `local/`: `serveLocally`.
- [x] Add `@govuk-once/flex-gateway-client` as a peer and a workspace devDependency.

### OpenAPI and logging

- [x] `openapi/document.ts`: `buildOpenApiDocument`, with servers, security and the Frontdoor's answers, validated in tests with `@scalar/openapi-parser` (the driver's). No snapshot yet.
- [ ] Decide between the JSON-line writer and Pino from the working code.

### Package and docs

- [ ] `package.json`: four entry points, rolldown build to `dist/`, `sideEffects: false`. Add the SDK to the release sources.
- [ ] `domains/configuration.md`: the status table and handler context above; remove the "Planned" caution.
- [ ] New `domains/requests.md`: Request pipeline, Responses and Logging.
- [ ] `domains/overview.mdx`, `start/platform.mdx`: SDK runtime marked built.

### Verify in dev

- [ ] Deploy the sandbox on the SDK and log one real proxy event. Confirm whether `event.path` arrives percent-decoded and whether it carries a base path; adjust `requestFrom` to match.
- [ ] Through the Frontdoor, call a declared route, an unknown path (404), a wrong method (405), an invalid input (400) and a declared 4xx. Check one log line per request, at the level its outcome gives, with no request data.

### Sandbox (`flex-platform-domain-sandbox`)

- [ ] Add `.npmrc` and `minimumReleaseAgeExclude: ["@govuk-once/*"]`; give CI's checks job `packages: read` and `NODE_AUTH_TOKEN`.
- [ ] Replace `hono` and `@hono/aws-lambda` with the four pinned dependencies.
- [ ] Add `schemas.ts`, `domain.ts`, `version.ts`, `local.ts` and `routes/` (`GET /v1/hello`, `GET /v1/hello/{name}`, `GET /v1/ping`). Make `function/handler.ts` `createLambdaHandler(domain)`. Delete `function/app.ts`.
- [ ] Replace `app.test.ts` with `domain.test.ts` on `createTestClient`. A wrong method now expects 405.
- [ ] Raise `version` to `1.3.0`, and update the README's table.
