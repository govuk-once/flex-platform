---
title: Environment
description: The environment variables a deployed gateway reads, and the secret it expects.
---

A deployed gateway reads six environment variables of its own, and `AWS_REGION`, which Lambda
sets. Only the generated entry point reads them, through `readUpstreamOptions` and
`readCallerTokenVerifier`. Gateway code never
names a deployed address, a credential or an environment. These belong to the deployment.

| Variable | Required | Purpose |
|---|---|---|
| `FLEX_UPSTREAM_SECRET_ARN` | Yes, for every gateway, including one that sends no credential | The AWS Secrets Manager secret that the driver reads its credentials from. The secret may also hold the target. |
| `FLEX_CALLER_TOKEN_KEYS_BUCKET` | Yes | The S3 bucket holding the edge's public keys, which the [caller token](/flex-platform/frontdoor/caller-token/) is verified with, in the gateway's region |
| `FLEX_CALLER_TOKEN_KEYS_OBJECT` | Yes | The public keys' object in that bucket |
| `FLEX_CALLER_TOKEN_KEYS_ACCOUNT` | Yes | The frontdoor account, which owns that bucket. Every read names it, so a bucket of the same name in another account is refused |
| `FLEX_CALLER_TOKEN_AUDIENCE` | Yes | The `aud` the token must name: `flex:<environment>:gateways` |
| `FLEX_UPSTREAM_TARGET` | Yes, unless the driver takes the target from a field of the secret | Where the upstream is. The driver decides what it means. |

If a driver's configuration names a secret field for the target and both are set, the driver uses
the secret's field.

## The secret

The secret must be in the gateway's own region, `AWS_REGION`, because the gateway reaches Secrets
Manager through its [network's endpoint](/flex-platform/infrastructure/network/#endpoints), which
serves that region only. An upstream that keeps its secret in another region replicates it to the
gateway's. A secret in another region stops the gateway as it starts.

The runtime retrieves the secret as a JSON object through Powertools Parameters. It caches the
secret for five minutes, then reads it again on the first call after that. Concurrent calls on a
cold or expired cache may each read the secret: nothing coordinates them. The runtime does not
know what fields the secret has.

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
| Runtime | Node.js 24, on arm64 |
| Memory | 1024 MB |
| Timeout | 28 seconds, since a domain answers within API Gateway's 29 |
| Invokes sent as an event | Run once at most, and dropped if not started within 60 seconds |
| Logs | `/flex/gateway/<environment>/<id>/function`, a `PlatformLogGroup` in the stack |
| Subnets and security group | Its placement's, which the [network](/flex-platform/infrastructure/network/#ids-other-stacks-read) writes to SSM |
| Variables | `FLEX_UPSTREAM_SECRET_ARN`, `FLEX_CALLER_TOKEN_KEYS_BUCKET`, `FLEX_CALLER_TOKEN_KEYS_OBJECT`, `FLEX_CALLER_TOKEN_KEYS_ACCOUNT`, `FLEX_CALLER_TOKEN_AUDIENCE`, and `FLEX_UPSTREAM_TARGET` unless config's `target` is `null` |

The stack owns the code, the version and the alias, so a gateway is released only by deploying its
stack. The alias moves to a new version once the version exists, so no call meets new code with
old variables.

The client invokes a gateway and waits for its answer. Lambda also takes an invoke sent as an
event, which by default it runs again, twice, when the function fails, and that could send an
upstream write the first run had already made. So the function, each version and the alias are
each set to no retry, and to the shortest time Lambda holds an event it has not yet run. Lambda
keeps these settings separately for each of the three.

Its role, `gateway-<environment>-<id>-execution`, may:

- write to its own log group, with its stack's log group key;
- create and remove the function's network interfaces, which Lambda does as the role. A deny on
  every gateway's function stops the function's own code doing the same;
- read its secret, and decrypt it with an upstream's key where the upstream holds it;
- assume the roles config lists for it;
- read the edge's public keys, `caller-token-keys.json` in the frontdoor account's
  `frontdoor-<environment>-keys-<account>`, through the network's `s3` endpoint, only while that
  account owns the bucket. The bucket's policy names the role too: see
  [the public keys' bucket](/flex-platform/frontdoor/caller-token/#the-public-keys-bucket).

It may read the secret and assume the roles only through the network's `secretsmanager` and `sts`
endpoints: a deny on any other `aws:SourceVpce` refuses the same calls through NAT, or from outside
AWS with the role's credentials.

A secret the stack creates, `gateway-<environment>-<id>`, starts with no value, for a person to
put, and the stack keeps it when it is deleted. Its resource policy refuses every reader but the
gateway's role, and every read that does not come through the network's `secretsmanager` endpoint,
whatever any other policy allows. Its rotation is planned.

The handler is built while the function initialises. A missing or invalid secret prevents
initialisation from completing, before the handler can process an event. This check runs when
the bundle loads; code generation does not retrieve the secret or test deployment permissions.

Each read of the secret allows 2 s to connect and 5 s for the request, and the AWS SDK's own
retries stay on, because a read sends nothing to the upstream. So a slow store can hold
initialisation for several of those, and nothing bounds it as a whole except Lambda's own limit on
initialising a function.

Initialisation failures occur outside the handler and do not return a gateway error envelope.
An invalid secret read after startup instead fails the affected call as `INTERNAL`.

Whether the function is placed `isolated` or `private` depends on how its upstream is reached, and
is set in [config](/flex-platform/infrastructure/overview/#config). See
[Egress](/flex-platform/start/platform/#egress).
