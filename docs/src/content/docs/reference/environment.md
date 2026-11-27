---
title: Environment
description: The environment variables a deployed gateway reads, and the secret it expects.
---

A deployed gateway reads five environment variables of its own, plus `AWS_REGION`, which Lambda
sets. Only the generated entry point reads them, through `readUpstreamOptions` and
`readCallerTokenVerifier`. Gateway code never names a deployed address, a credential or an
environment: those belong to the deployment.

| Variable | Required | Purpose |
|---|---|---|
| `FLEX_UPSTREAM_SECRET_ARN` | Yes, for every gateway, including one that sends no credential | The AWS Secrets Manager secret that the driver reads its credentials from. The secret may also hold the target. |
| `FLEX_CALLER_TOKEN_KEYS_TABLE` | Yes | The ARN of the DynamoDB table that holds the edge's public keys, which verify the [caller token](/flex-platform/frontdoor/caller-token/). The ARN names the frontdoor account. The table must be in the gateway's region |
| `FLEX_CALLER_TOKEN_KEYS_ENDPOINT` | Yes | The hostname of the network's `dynamodb` endpoint, with nothing else. The gateway reads the keys table through it, over HTTPS. The endpoint has no private DNS, so DynamoDB's usual name doesn't reach it |
| `FLEX_CALLER_TOKEN_AUDIENCE` | Yes | The `aud` the token must name: `flex:<environment>:gateways` |
| `FLEX_UPSTREAM_TARGET` | Yes, unless the driver takes the target from a field of the secret | Where the upstream is. The driver decides what it means. |

If a driver's configuration names a secret field for the target and both are set, the driver uses
the secret's field.

## The secret

The secret must be in the gateway's own region, `AWS_REGION`. The gateway reaches Secrets Manager
through its [network's endpoint](/flex-platform/infrastructure/network/#endpoints), which serves
that region only. If an upstream keeps its secret in another region, it replicates the secret to
the gateway's. A secret in another region stops the gateway as it starts.

The runtime retrieves the secret as a JSON object through Powertools Parameters. It caches the
secret for five minutes, then reads it again on the first call after that. If several calls arrive
while the cache is cold or expired, each may read the secret, because nothing coordinates them.
The runtime doesn't know what fields the secret has.

The driver reads only the fields its configuration names, checks each of them on every read, and
ignores the rest. So the secret can be the gateway's own, or one that an upstream provides in its
own shape. For openapi-rest, see
[Authentication](/flex-platform/drivers/openapi-rest/authentication/).

The function's role may read its secret, and assume the roles config lists for the driver's
authentication. See [the Lambda function](#the-lambda-function).

## The Lambda function

Each gateway's stack, `gateway-<environment>-<account>-<id>`, deploys its function from the bundle
codegen writes, with these settings:

| Setting | Value |
|---|---|
| Name | `gateway-<environment>-<id>`, invoked through its alias, `live` |
| Code | `.gen/runtime/bundle.mjs`, alone |
| Handler | `bundle.handler` |
| Runtime | Node.js 26, on arm64 |
| Memory | 1024 MB |
| Timeout | 28 seconds, since a domain answers within API Gateway's 29 |
| Invokes sent as an event | Run once at most, and dropped if not started within 60 seconds |
| Logs | `/flex/gateway/<environment>/<id>/function`, a `PlatformLogGroup` in the stack |
| Subnets and security group | Its placement's, which the [network](/flex-platform/infrastructure/network/#ids-other-stacks-read) writes to SSM |
| Variables | `FLEX_UPSTREAM_SECRET_ARN`, `FLEX_CALLER_TOKEN_KEYS_TABLE`, `FLEX_CALLER_TOKEN_KEYS_ENDPOINT`, `FLEX_CALLER_TOKEN_AUDIENCE`, and `FLEX_UPSTREAM_TARGET` unless config's `target` is `null` |

Whether the function is placed `isolated` or `private` depends on how its upstream is reached, and
is set in [config](/flex-platform/infrastructure/config/). See
[placement](/flex-platform/gateways/overview/#placement).

The stack owns the code, the version and the alias, so deploying its stack is the only way to
release a gateway. The alias moves to a new version only once that version exists, so no call
meets new code with old variables.

The client invokes a gateway and waits for its answer. Lambda also accepts an invoke sent as an
event. By default, if the function fails, Lambda runs such an event twice more, which could repeat
an upstream write the first run had already made. So the function, each version and the alias are
all set to no retries, and to the shortest time Lambda holds an event it hasn't run yet. Lambda
keeps these settings separately for each of the three, so each is set.

Its role, `gateway-<environment>-<id>-execution`, may:

- write to its own log group, with its stack's log group key;
- create and remove the function's network interfaces, which Lambda does as the role. A deny on
  every gateway's function stops the function's own code doing the same;
- read its secret, and decrypt it with an upstream's key where the upstream holds it;
- assume the roles config lists for it;
- scan the edge's public keys, the frontdoor account's
  `frontdoor-<environment>-caller-token-public-keys` table, through the network's `dynamodb`
  endpoint. The table's policy names the role too: see
  [the tables](/flex-platform/frontdoor/caller-token/#the-tables).

The role may read the secret and assume the roles only through the network's `secretsmanager` and
`sts` endpoints. A deny on any other `aws:SourceVpce` refuses the same calls through NAT, or from
outside AWS with the role's credentials.

The stack creates a secret, `gateway-<environment>-<id>`, with no value, for a person to put. The
stack keeps the secret if the stack is deleted. Whatever any other policy allows, the secret's
resource policy refuses:

- every reader but the gateway's role;
- every read that doesn't come through the network's `secretsmanager` endpoint.

Rotation of this secret is planned.

### Starting up

The handler is built while the function initialises, when the bundle loads. A missing or invalid
secret stops initialisation before the handler takes an event. Code generation doesn't retrieve
the secret or test deployment permissions, so this is the first place either is checked.

Each read of the secret allows 2 s to connect and 5 s for the request. The AWS SDK's own retries
stay on, because a read sends nothing to the upstream. So a slow store can hold up initialisation
for several of those timeouts. Only Lambda's own limit on initialising a function bounds it as a
whole.

A failure during initialisation happens outside the handler, so it returns no gateway error
envelope. A secret that turns out invalid on a read after startup fails the affected call as
`INTERNAL` instead.
