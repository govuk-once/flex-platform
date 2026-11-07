---
title: The caller token
description: The token that says who a request is for, how the edge signs it, and how key rotation makes, schedules, publishes and removes its keys.
---

The caller token is the platform's statement of who a request is for. Lambda@Edge signs it and
sends it as `x-flex-secure`, a domain passes it on to the gateways it calls, and each gateway is
to verify it before it acts, which is planned.

## The token

A compact JWS, signed with EdDSA over Ed25519:

| Part | Holds |
|---|---|
| Header | `alg: "EdDSA"`, `typ: "JWT"`, and `kid`, the [key](#keys) it was signed with |
| `pairwiseId` | The verified access token's `username` |
| `service` | The service the caller uses, whose namespace `pairwiseId` is in: One Login gives each service its own pairwise IDs. `"app"`, the one service the Frontdoor serves |
| `aud` | `flex:<environment>:gateways`, the environment's gateways |
| `iat`, `exp` | When it was signed, and a minute later |
| `jti` | CloudFront's ID for the request, so each gateway call traces to the request that made it |

It holds nothing of the request itself, its method, path or host: the gateway never sees the
request, only what the domain sends it. Within its minute, a domain can use it for any number of
gateway calls, but only for that user.

## Signing

Lambda@Edge reads its signing keys from eu-west-2, wherever the copy runs. It reads the signing key
parameter from SSM: the key signing now and the one scheduled next, each with the moment it starts.
It decrypts each private key it doesn't already hold with KMS, with the key's encryption context.
Each call is signed with the function's own role and has 1.5 seconds.

It signs with the latest key that has started. It already holds the next key, so every copy
switches at the scheduled moment without a read. It reads the parameter again every five minutes,
so a [revocation](#revoking-a-key) normally reaches every copy within five minutes, and calls KMS
only for a key it hasn't seen. A read that fails keeps the keys it has, however old, and isn't tried
again for 30 seconds. So an edge that can't read goes on signing with a revoked key, which
gateways are to refuse. With no key that has started, the request is the 500, and the next read waits 30 seconds too, so
SSM isn't asked again by every request while it can't be reached. Requests that arrive while a read
is under way share it.

## Keys

The token is signed with an Ed25519 key pair, made by KMS's `GenerateDataKeyPairWithoutPlaintext`.
KMS returns the public key, and the private key encrypted under a KMS key of the platform's. No
plaintext private key leaves KMS except to the edge that decrypts it to sign.

The keys are made and kept in eu-west-2, nearest to most requests, so a cold start in London
never waits on a call across the Atlantic to [sign](#signing). Every copy of the edge, wherever it
runs, reads them there.

A key ID names the time the key was made, such as `20261106T120000Z`, so key IDs sort by age.

| What | Where | Holds |
|---|---|---|
| `alias/frontdoor-<environment>-caller-token` | KMS, frontdoor account, eu-west-2 | The key that wraps the private keys. Retained, with rotation of its own key material on |
| `/flex/frontdoor/<environment>/caller-token-signing-key` | SSM, frontdoor account, eu-west-2 | `{ keys: [{ kid, privateKey, signsFrom }] }`: the keys the edge signs with now and next, each private key as KMS encrypted it, and when each starts, in seconds since the epoch |
| `/flex/frontdoor/<environment>/caller-token-key-state` | SSM, frontdoor account, eu-west-2 | Every key rotation holds, when each starts, and when each stops once its successor is scheduled. The ID of each key revoked in the last day, and when |
| `caller-token-keys.json` in `frontdoor-<environment>-keys-<account>` | S3, frontdoor account, eu-west-2 | The public keys, as a JWK set, each with `signsFrom` and, once its successor is scheduled, `signsUntil`. Gateways are to read it through their network's [`s3` endpoint](/flex-platform/infrastructure/network/#the-caller-tokens-keys) |

Each private key is encrypted with the encryption context `{ purpose: "flex-caller-token", kid }`.
A ciphertext decrypts only with the same context, so one key's ciphertext can never be passed off
as another's, and a role may be given decryption for this purpose alone.

No stack holds a parameter's value or the object: key rotation writes them, and a template would
put back what it last deployed whenever it changed.

### The public keys' bucket

The public keys are in one place, which every gateway in every domain account is to read, so a key is
in every gateway's reach the moment rotation writes it, and adding a domain account adds nothing
for rotation to write. The bucket's name ends in the frontdoor account's ID, since bucket names are
global, and both come from config, so every stack derives it.

The bucket's policy lets each gateway's role, `gateway-<environment>-<id>-execution` in each domain
account that runs it, read that one object. It names the accounts as principals and holds them to
the exact roles with an `aws:PrincipalArn` condition, because a policy naming a role that doesn't
exist yet is refused, and a gateway's stack may deploy after it. Each gateway's role grants itself
the same read.

Bucket names are global, and this one is derived from config in a public repository, so anyone can
make a bucket of the same name in their own account, before the frontdoor's exists or after it is
gone. So every read and write names the frontdoor account as the bucket's owner, with
`ExpectedBucketOwner`, and every grant holds the bucket to that account with `aws:ResourceAccount`:
the gateways' roles, the `s3` endpoint's policy and key rotation's role. A bucket of the same name
elsewhere is never read, so its keys are never trusted, and never written to. At worst it fails the
frontdoor's deploy.

The bucket is encrypted with S3's own keys, since a KMS key would need a grant for
every domain account too. It is retained, versioned, and refuses plain HTTP, as every
[`PlatformBucket`](/flex-platform/infrastructure/overview/#checks) does.

## Rotation

Key rotation is a Lambda function, `frontdoor-<environment>-key-rotation`, in eu-west-2. A
schedule runs it every 15 minutes. Each run does what is due and nothing more, so a run that fails
is simply retried by the next. Only one copy runs at a time, so two runs never write the state at
once.

A switch from one key to the next is a moment, set when the next key is made:

1. **Scheduled.** When there is no next key, a run makes one, to start seven days after the current
   key started, and keeps that moment as when the current key stops. A time that has passed never
   changes, so a key that has stopped signing never signs again. The new key is published, and given
   to the edge, in the same run. A key is
   never scheduled less than an hour ahead, longer than an edge goes between reads or a gateway
   keeps the public keys, even after the runs have stopped for longer than seven days.
2. **Signing.** At that moment every edge signs with it, since each already holds it, and every
   gateway is to accept it, since each will already hold its public key. The key it replaces stops
   verifying a little over a minute later, when its last token expires.
3. **Removed.** Five minutes after a key is replaced, a run takes it out of the public keys. The
   edge's parameter already left it out.

Rotation needs no downtime, and no edge or gateway has to read anything at the moment of a switch.

A run writes its state first, so a key it has made is never lost, then the public keys, then the
edge's signing keys. If the public keys can't be written, no edge is given anything new, so no edge
holds a key a gateway can't. If the signing keys can't be written, the run fails and the next run
writes them again. A key is normally scheduled seven days ahead, so there are hundreds
of runs to do it in. Each run writes what each reader should hold, and only what differs from what
is there, so a run with nothing due adds no version.

On an environment's first run, the first key is made to start at once, since no edge has signed
anything yet. The second run, 15 minutes later, schedules the next key. Until the
first run, which the schedule starts within 15 minutes of the key rotation stack deploying, every
signed request is the edge's 500. Nothing else starts a run, so the schedule is the one place keys
are made.

### Revoking a key

To remove a key at once, invoke the function with `{ "revoke": "<kid>" }`. The key leaves the
public keys and the edge's parameter in that run. If the edge was signing with it, a new key is
made that starts at once, and the key it replaced stays stopped. If it was the next key, a new one
is scheduled for the same moment, or an hour ahead if that is later, and the signing key now stops
when the new one starts.

A revocation whose writes fail part way can be run again with the same request. Rotation keeps the
ID of each key it revokes for a day, so it knows the key, reports it as already revoked, and writes
whatever is still to be written. A key ID it neither holds nor has revoked fails the run, changing
nothing.

An edge stops signing with the key at its next read, normally within five minutes. One that can't
read goes on signing with it.

### Permissions

The function's role, `frontdoor-<environment>-key-rotation`, may:

- make key pairs only under the signing key, found by its alias, since KMS generates the key's ID,
  and only with the caller token's encryption context purpose;
- read and write its state, and the signing key parameter;
- read and write the public keys' object, in its own account's bucket;
- write to its own log group, `/flex/frontdoor/<environment>/key-rotation`.

It logs each key it makes, with when it starts, and each it removes or revokes, by key ID alone. A
failed run logs the AWS error's name and the source locations, and fails, so Lambda's error metric
counts it.

## Stacks

| Stack | Region | Holds |
|---|---|---|
| `frontdoor-<environment>-signing-key` | eu-west-2 | The signing key and its alias. Protected from deletion |
| `frontdoor-<environment>-caller-token-keys` | eu-west-2 | The [public keys' bucket](#the-public-keys-bucket) and its policy. Protected from deletion |
| `frontdoor-<environment>-key-rotation` | eu-west-2 | The function, its role, log group and schedule |

The key rotation stack depends on the signing key stack and the public keys' stack. A gateway's
stack depends on none of them: a gateway finds the bucket by name, and reads it only when called.
