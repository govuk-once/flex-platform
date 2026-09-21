# Reach an upstream path its document leaves to a catch-all template, without letting a caller choose one

**Placeholder:** FLEX-111
**Branch:** `feat/openapi-rest-matches-and-narrow` (4 commits)
**Depends on:** the SigV4 authentication ticket

## Why

An upstream may serve paths it does not declare, through a template that takes every segment that
is left — `/v1/{resourcePath+}` for a store that keeps whatever it is given under whatever path.
UDP does exactly this, and half the operations Flex needs from it live behind that template. Two
problems follow:

1. Deriving fails, because the document declares no path matching the operation's `upstream`.
2. The obvious fix — a path parameter the caller fills — is the one thing that must never exist. A
   parameter that can hold several segments would let one operation reach every other operation's
   endpoint, past its input schema, its `secure` bindings and its logging. **No caller chooses an
   upstream path** (design constraint 15).

Such a template also describes data of any shape, so an operation behind it derives a contract that
promises a caller nothing.

## Scope

- The driver refuses a path parameter value holding a `/`: a path parameter is one segment.
- An operation reaches a catch-all template only by writing its path out in full and naming the
  template as its `matches`:

  ```ts
  getNotificationPreferences: {
    upstream: "GET /v1/notifications",
    matches: "/v1/{resourcePath+}",
    narrow: { outcomes: { ok: { type: "object", properties: { data: NOTIFICATION_PREFERENCES } } } },
  },
  ```

- `matches` is said, never inferred: a path the document lacks fails deriving unless the operation
  names what serves it, and the failure names the templates that could serve it. Deriving then
  checks that the template exists, that the path fits it — `{name}` taking one segment, `{name+}`
  one or more, all written out — and that **no more specific template fits**, since that is the one
  the upstream would route to. `matches` on a path the document does declare is refused.
- What the path fills of the template needs no input field: no caller supplies it. An ordinary
  parameter can be filled the same way (`GET /v1/identity/app/{id}` against
  `/v1/identity/{serviceName}/{identifier}`), and one the path keeps goes by the path's name for it.
  The request is sent to the path in `upstream` either way; only deriving reads `matches`.
- `narrow` states the shape a gateway's own services keep behind such a template: `payload` for the
  request body and `outcomes` by name. **It can make a schema admit less and nothing else.** Where
  the document says "an object of any shape", what is stated takes its place; where it describes an
  object, what is stated of a field is set into it, a field may be required or the object closed,
  and a field the document's object has no room for is refused; anything else is set beside the
  document's as an `allOf`.
- A narrowed body is used as written, so it is as strict as it is written to be. A narrowed outcome
  is still held to its shape like any other — opened, unbounded — because what one of a gateway's
  own services comes to keep there should fail no other's read of it. A narrowing is written out in
  full: it has nothing a `$ref` could refer to.

## Acceptance criteria

- [ ] A path value containing `/` is refused at request time.
- [ ] Deriving an operation whose path the document lacks fails unless it names `matches`, and the
      failure lists the templates that could serve it.
- [ ] `matches` is refused where the path is declared, where the path does not fit the template,
      and where a more specific template would be routed to.
- [ ] `narrow` may only make a schema admit less; a narrowing the document's object has no room for
      fails deriving.
- [ ] A narrowed outcome is opened and unbounded like any other outcome; a narrowed payload is not.
- [ ] `matches` and `narrow` are documented in `gateways/README.md`, with the reason a caller never
      chooses a path.
