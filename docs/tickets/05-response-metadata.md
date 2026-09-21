# Report what a gateway learns about an exchange beside its result

**Placeholder:** FLEX-111
**Branch:** `feat/gateway-response-meta` (4 commits)
**Depends on:** the schema derivation ticket

## Why

When a call goes wrong, the first thing an upstream's support asks for is its own id for the
request. Today that arrives in a response header the driver reads and throws away: a caller sees
`{ ok: false, error: { code } }` and nothing that identifies the exchange to the team that owns
the upstream. The rule that diagnostic detail stays out of the response contract is right and
stays; what is missing is a narrow, declared channel for facts that are not diagnostics.

## Scope

- Either response may carry `meta`. A gateway's schemas declare each name under `meta` with the
  schema of **one scalar** — string, number, integer or boolean, never an object or a list.
- A driver reports through its context, `ctx.meta(name, value)`, not in its result, because a
  driver that fails throws and what it learnt before it threw is what a caller most needs.
- The runtime keeps only the names the gateway declared, validates each against its schema, returns
  what passes on a failure as on a success — the unhandled path included — and writes it to that
  call's log line. What fails validation is left out and logged as the schema location that refused
  it, never as its value. **Nothing reported can fail a call.**
- Every part of `meta` is optional to a caller, and so is the whole: a request refused before it
  reached the upstream, or one that timed out, has nothing to report.
- Codegen generates validators for `meta` and declares it in the call contract. The shared envelope
  types take any name under `meta`, since they describe every gateway, so the contract declares its
  own and a name the gateway does not declare is a type error. A gateway that reports nothing has
  no `meta` in its types at all.
- Between versions `meta` is compared as an outcome is: a name added is safe, one removed breaks.
- `openapi-rest` gains `metadata`, naming each value, the response header it is read from and the
  schema of what it carries. A caller reads `meta.upstreamRequestId` and never sees the header's
  name, which is this transport's. Headers are read **before** the status is mapped, so a response
  the driver turns into an error code reports as a success does; one that never arrived reports
  nothing. A header is text: one whose schema is a number, integer or boolean is read as that where
  the text is one and left as text where it is not, for the gateway's validator to refuse.
- Deriving copies each schema into the gateway's `meta`. Codegen fails when a name is in the schemas
  and not in `metadata` or the other way round, and the executor refuses to start on `metadata` it
  cannot read.
- Design constraint 4 gains the rule: `meta` is not a way round "errors carry codes" — only names
  the schemas declare, each a scalar validated against its schema, and never a message.

## Acceptance criteria

- [ ] A driver reporting a declared value sees it on the success response, on a mapped error
      response and on an unhandled failure, and in the call's log line.
- [ ] An undeclared name, or a value its schema refuses, is dropped; the call succeeds; the log
      names the schema location and not the value.
- [ ] The generated contract types `meta` per gateway; an undeclared name is a type error; a
      gateway with no metadata has no `meta` in its types.
- [ ] A metadata schema keeps its own shape: what an OpenAPI document says about a response header
      is not used.
- [ ] Codegen fails on a mismatch between `metadata` and the schemas, in either direction.

## Notes

The gateway's metadata schema should be kept loose. It is there to bound what reaches a caller and
a log, and an upstream that changes how its ids look has changed nothing a caller relies on.
