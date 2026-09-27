---
title: Environment
description: The environment variables a deployed gateway reads, and the secret it expects.
---

A deployed gateway reads two environment variables. Only the generated entry point reads them,
through `readUpstreamOptions`. Gateway code never names a deployed address, a credential or an
environment. These belong to the deployment.

| Variable | Required | Purpose |
|---|---|---|
| `UPSTREAM_SECRET_ARN` | Yes, for every gateway, including one that sends no credential | The AWS Secrets Manager secret that the driver reads its credentials from. The secret may also hold the target. |
| `UPSTREAM_TARGET` | Yes, unless the driver takes the target from a field of the secret | Where the upstream is. The driver decides what it means. |

If a driver's configuration names a secret field for the target and both are set, the driver uses
the secret's field.

## The secret

The runtime retrieves the secret as a JSON object through Powertools Parameters. It caches the
secret for five minutes, then reads it again on the first call after that. The runtime does not
know what fields the secret has.

The driver reads only the fields its configuration names with `fromSecret`. It checks each of
these fields on every read, and ignores the rest. This means the secret can be the gateway's own,
or one that an upstream provides in its own shape.

The function's execution role needs permission to read the secret, and any permissions the
driver's authentication needs.

## The Lambda function

| Setting | Value |
|---|---|
| Code | `.gen/runtime/bundle.mjs` |
| Handler | `bundle.handler` |
| Runtime | Node.js 24 |

The handler is built while the function initialises. A missing or invalid secret prevents
initialisation from completing, before the handler can process an event. This check runs when
the bundle loads; code generation does not retrieve the secret or test deployment permissions.

Initialisation failures occur outside the handler and do not return a gateway error envelope.
An invalid secret read after startup instead fails the affected call as `INTERNAL`.

Whether the function is placed `isolated` or `private` depends on how its upstream is reached. See
[Egress](/flex-platform/start/platform/#egress).
