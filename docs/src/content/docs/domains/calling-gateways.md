---
title: Calling gateways
description: How a domain calls a gateway through its typed client, what each call carries, and what the client throws when the gateway doesn't answer.
---

A domain calls a gateway through the gateway client, `@govuk-once/flex-gateway-client`. The
client invokes the gateway's Lambda function directly through the Lambda API, not over HTTP.

Codegen builds each gateway a [client package](/flex-platform/codegen/overview/#the-client-package).
It holds the gateway's [call contract](/flex-platform/codegen/call-contract/) and one function,
named for the gateway, that creates a client typed by that contract. A domain installs:

- the gateway client;
- the client package of each gateway it calls;
- `@aws-sdk/client-lambda`, the gateway client's one peer dependency.

```ts
import { GatewayInvocationError } from "@govuk-once/flex-gateway-client";
import { createUdpClient } from "@govuk-once/flex-gateway-udp-client";

const udp = createUdpClient();

const response = await udp.getIdentity({ serviceName, identifier });
```

The client takes no settings, so a domain is never given a function name or an ARN. The client
invokes the function `gateway-<environment>-<id>` through its one alias, `live`, in the domain's
own account and region. Gateways and domains share an account, and each gateway's stack deploys its
function under this name.

The name follows the
[template every resource name follows](/flex-platform/infrastructure/overview/#rules-for-stacks-and-constructs).
So a domain's permissions can name its own environment's gateways and no other's.

The client takes the environment from the `FLEX_ENVIRONMENT` variable. A
[release](/flex-platform/domains/releasing/) sets it on every domain's
function. The client reads the variable on its first call, not when it is created. So a module can
create its client as it is imported, and a call fails if the variable is not set. The Lambda client
takes the region and credentials from the function it runs in.

To test code that calls a gateway, set `FLEX_ENVIRONMENT`. Use the SDK's own
`AWS_ENDPOINT_URL_LAMBDA` variable to point the client at a stand-in for Lambda's API.

The client has one function for each of the gateway's operations, and nothing else. Each function
is named for its operation and takes the operation's input. An editor shows each function with the
description the configuration gives its operation. A call sends one
[envelope](/flex-platform/gateways/overview/#a-request) and returns the gateway's response. The
response is typed by the operation: it is either an error envelope or one of the operation's
outcomes.

The client sends each call only once, with the SDK's retries turned off (`maxAttempts: 1`). This is
because a retried invoke could repeat an upstream write, and deciding whether to retry needs to know
the operation and the deadline. The client leaves the invoke's `LogType` unset, so it never asks for
the end of the gateway's execution log.

A call's second argument, its options, can carry a `signal` that stops the client waiting.

## The caller context

The caller context holds what a call sends on its caller's behalf. The call itself does not carry
it. The context is set once for the whole of a domain's invocation, by running the handler inside
`withCallerContext` from `@govuk-once/flex-gateway-client/caller`. Every call made from the
handler then carries it, however many `await`s deep.

The [domain SDK](/flex-platform/domains/overview/#domain-sdk) does this for every handler it calls, so a domain developer does not
need to. This entry point is kept apart from the client's main one so that an editor does not offer
it. Nothing exports a way to read the context back.

```ts
import { withCallerContext } from "@govuk-once/flex-gateway-client/caller";

withCallerContext({ deadline, secure }, () => handler(event));
```

- `deadline` is when the caller stops waiting, in epoch milliseconds. At that time the client
  abandons any call still waiting, and it does not send a call made after it. The caller keeps its
  own margin for answering after a call. The deadline is not yet sent to the gateway. The gateway
  works out its own deadline from its invocation.
- `secure` is `{ token }`. The token is the [caller token](/flex-platform/frontdoor/caller-token/)
  from the request's `x-flex-secure` header, passed on unchanged. The gateway verifies it, and
  compares an operation's [bound fields](/flex-platform/gateways/configuration/#secure-bindings)
  with its claims. If `secure` is missing, the client sends no token. The gateway then refuses
  every call with `UNAUTHENTICATED`, even for an operation with no bindings.

If a call is made outside a caller context, the client refuses it before sending anything. It
throws an `Error`, not a `GatewayInvocationError`, because the mistake is in the caller's code.

## When the gateway does not answer

If the gateway does not answer, the client throws a `GatewayInvocationError` instead of returning
a response. Its `reason` is one of:

| Reason | When |
|---|---|
| `invoke_failed` | Lambda did not take the call: it was throttled, not permitted, or named no function, or Lambda was unreachable. |
| `function_error` | The function failed instead of answering, as it does when it times out or fails to start. |
| `invalid_response` | The answer is not a response envelope. |
| `aborted` | The call's `signal` stopped the wait. The call may still have completed, and it is not sent again. |
| `timed_out` | The caller's deadline passed, before the gateway answered or before the call was sent. One that was sent may still have completed, and it is not sent again. |

The error's message is fixed text, so it is safe to log. For `invoke_failed` it adds the SDK
error's name, and for `function_error` it adds Lambda's `FunctionError` value. It never includes
the service's message or the function's error payload, because either can hold request data.

## What the client checks

The client checks the response envelope's shape. It:

- reads only the fields an envelope has, and only those the answer holds itself, never inherited
  ones;
- refuses an error code the platform does not define;
- leaves out a `meta` value that is not a scalar, because every part of `meta` is optional to a
  caller.

The client does not check the outcome's data, or that the outcome is one the operation declares.
The gateway does that against its schemas before it answers. A gateway's contract only changes
[compatibly](/flex-platform/gateways/compatibility/), so a domain compiled against an earlier
version still understands every answer. If an upstream changes without warning, the gateway refuses
the change as `UPSTREAM_CONTRACT_VIOLATION`.
