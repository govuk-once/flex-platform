---
title: The caller token
description: The token that says who a request is for. How the edge signs it and derives its push ID, how gateways verify it, and how key rotation makes, schedules and removes its keys.
---

The caller token is the platform's statement of who a request is for. Lambda@Edge signs it and
sends it as `x-flex-secure`. A domain passes it on to the gateways it calls, and each gateway
verifies it before it acts. Any domain may call any gateway, so the token is what keeps a domain
to its own caller's records. A gateway compares the fields an operation
[binds](/flex-platform/gateways/configuration/#secure-bindings) with the token's claims.

## The token

The token is a compact JWS, signed with EdDSA over Ed25519:

| Part | Holds |
|---|---|
| Header | `alg: "EdDSA"`, `typ: "JWT"`, and `kid`, the [key](#keys) it was signed with |
| `pairwiseId` | The verified access token's `username` |
| `service` | The service the caller uses, whose namespace `pairwiseId` is in. One Login gives each service its own pairwise IDs. `"app"`, the one service the Frontdoor serves |
| `pushId` | The ID the caller's notifications are pushed to, [derived](#the-push-id) from `pairwiseId` |
| `aud` | `flex:<environment>:gateways`, the environment's gateways |
| `iat`, `exp` | When it was signed, and a minute later |
| `jti` | CloudFront's ID for the request, so each gateway call traces to the request that made it |

The token holds nothing of the request itself: not its method, path or host. The gateway never
sees the request, only what the domain sends it. Within its minute, a domain can use the token for
any number of gateway calls, but only for that user.

## Signing

Lambda@Edge signs each token with the latest key that has started and not stopped. It reads its
keys from eu-west-2, wherever the copy runs, and keeps them between reads:

| What | When |
|---|---|
| Read the private keys table | Every five minutes |
| Decrypt a key with KMS | Only for a key it doesn't already hold, that hasn't stopped, and that has started or starts within the hour |
| Each DynamoDB or KMS call | Has 1.5 seconds |
| After a read fails | Keeps the keys it has, however old, and doesn't try again for 30 seconds |
| If no key has started | Answers with a 500, and waits 30 seconds before the next read |

Each read gets the [private keys table](#keys) from DynamoDB. The table holds every key rotation
keeps. Each key has the moment it starts and, once the next key is scheduled, the moment it stops.
The edge decrypts each key with the key's encryption context. It signs each call with the
function's own role. The read fails if the table holds anything other than keys, or needs more
than one page. The edge never signs from part of the table.

Rotation schedules the next key seven days ahead, and few copies that read it then are still
running when it starts. So a copy leaves the next key until its last hour. That is 12 reads, and
the least notice [rotation](#rotation) gives of a key. By the time the key starts, every copy
holds it, so every copy switches at the scheduled moment without a read.

Because the edge reads every five minutes, a [revocation](#revoking-a-key) normally reaches every
copy within five minutes. The edge calls KMS only for a key it hasn't seen.

A failed read keeps the old keys. So an edge that can't read goes on signing with a revoked key,
and every gateway refuses what it signs. If no key has started, the 30-second wait means that every request doesn't
hit DynamoDB while it can't be reached. Requests that arrive while a read is under way share it.

## The push ID

`pushId` is `base64url(HMAC-SHA256(pairwiseId))`, keyed with a secret that only the edge reads. The
same user has the same push ID in every token. Nobody without the secret can turn one ID into the
other.

The secret is `frontdoor-<environment>-push-id-secret`, in Secrets Manager in the frontdoor account
in eu-west-2. Its stack creates it empty, and a person puts its value, as text. The edge keys the
HMAC with every character of that text, and never parses or trims it. Until the secret has a
value, the edge answers every request that has a valid token with a 500. A new value changes every
user's push ID, so the value is put once and never rotated. The secret's own policy refuses a read
by anything but the edge's role, whatever else allows it.

Lambda@Edge reads the secret from eu-west-2, wherever the copy runs, while it loads its signing
keys. It signs the call with the function's own role, and the call has 1.5 seconds. A copy reads
the secret once, and keeps it for as long as it runs, since the value never changes.

If a read fails, or finds the secret without a value, the edge answers with a 500. It signs no
token without the claim. It doesn't try the read again for 30 seconds, so a copy starts signing
within 30 seconds of a person putting the value. Requests that arrive while a read is under way
share it.

## Verifying

A domain passes the token as the envelope's `secure.token`, through the
[gateway client](/flex-platform/domains/overview/#the-caller-context). The
[domain SDK](/flex-platform/domains/requests/#the-handlers-context) reads `pairwiseId` and `pushId`
from it for a handler, and has no need to verify it. The gateway verifies it as the second step of
[a request](/flex-platform/gateways/overview/#a-request), before it routes the call. So a caller
without a valid token learns nothing of the gateway's operations.

The gateway works to these timings:

| What | When |
|---|---|
| Read the public keys | On the first call, then again once a minute has passed |
| A token names a key ID it doesn't hold | Reads the keys again |
| Any read | At most once every ten seconds |
| After a read fails | Keeps the keys it has for five minutes from the last read that worked |
| Clock allowance on `iat` and `exp` | 5 seconds either way |
| A token's longest life | A minute |

A call without a token returns `UNAUTHENTICATED`, because the domain didn't pass it on. A token
that fails any of these checks returns `SECURE_SIGNATURE_INVALID`. The log names the check, never
a value from the token:

- it is a compact JWS of three base64url parts, each written the one way an encoder writes it, of
  at most 4,096 characters;
- `alg` is `EdDSA`, and no `crit` header asks for anything more. The header never chooses how the
  token is checked;
- `kid` has a key ID's shape, checked before it is looked up, and names a key the gateway holds;
- the Ed25519 signature verifies;
- `aud` is the gateway's own environment's, `FLEX_CALLER_TOKEN_AUDIENCE`;
- `iat` and `exp` are numbers. The token lives a minute at most, wasn't issued in the future and
  hasn't expired, allowing the clocks 5 seconds either way;
- `iat` falls while the key signs: not before it started, and not after it stopped, allowing the
  same 5 seconds;
- `jti` has the shape of CloudFront's request IDs;
- each claim, `pairwiseId`, `service` and `pushId`, is a string that isn't empty. Only the
  token's own properties are read.

After the check, every log line for the call holds `frontdoorRequestId`, the token's `jti`. It
joins the line to the edge's line for the request. The token and its claims are never logged.

The gateway reads the public keys from the [public keys table](#keys), named by its ARN in
`FLEX_CALLER_TOKEN_KEYS_TABLE`. It reads over HTTPS, through its network's
[`dynamodb` endpoint](/flex-platform/infrastructure/network/#the-caller-tokens-keys), at the name in
`FLEX_CALLER_TOKEN_KEYS_ENDPOINT`. Because it reads again after a minute, it refuses a revoked key
within a minute. The ten-second limit means a caller can't make every call read the keys. It also
means every call doesn't ask a store that can't be reached.

Each read scans the whole table in one page. Rotation never keeps enough keys to need a second
page, so a table that does is treated as wrong and the read fails. Each key's item gives an Ed25519
public key, in DER, and the times it signs between. The gateway passes over a revoked key's record
and `#version`, which hold no key.

The whole read fails if the table holds:

- anything else;
- a key of any other type;
- a revoked key's record that holds a key. Rotation's own read refuses this too: an item is a key
  or the record of one revoked, never both.

If a read fails, the gateway keeps the keys it has for five minutes from the last read that worked.
That is time for a failed read to be tried again many times. A key revoked in that time is one the
gateway can't know of. So once the five minutes have passed, the gateway refuses every token until
a read works. Each call returns `INTERNAL`, since no caller can have caused it. So does a call when
the gateway holds no keys at all.

The gateway logs each read that fails as a warning, `The caller token's keys could not be read`. So
a table a gateway can't read shows in its log at once, not when calls fail five minutes later. The
line's `reason` is one of:

- AWS's name for the error, such as `AccessDeniedException`;
- if the gateway itself refused what the table held, one of `item_without_key_id`,
  `item_not_a_key`, `revoked_item_with_key` and `more_than_one_page`;
- `unnamed_error`, for an error with no name of that kind.

The line never holds the error's message, an item or a key.

Holding `iat` to the key's times is what lets a key go quickly. A token signed just before a
switch verifies for the rest of its minute. A token issued after the switch fails, even if someone
holding the old private key signed it. So the old key verifies nothing a little over a minute after
the switch, whenever it leaves the public keys. A key made ahead of its time verifies nothing
before it starts.

The verifier is written on Node's `crypto` alone. It accepts one algorithm, so a library's choice
of algorithms would only be more to keep shut.

## Keys

The token is signed with an Ed25519 key pair, made by KMS's `GenerateDataKeyPairWithoutPlaintext`.
KMS returns the public key, and the private key encrypted under a KMS key of the platform's. No
plaintext private key leaves KMS, except to the edge that decrypts it to sign.

The keys are made and kept in eu-west-2, nearest to most requests. So a cold start in London never
waits on a call across the Atlantic to [sign](#signing). Every copy of the edge reads them there,
wherever it runs.

A key ID names the time the key was made, such as `20261106T120000Z`, so key IDs sort by age.

| What | Where | Holds |
|---|---|---|
| `alias/frontdoor-<environment>-caller-token` | KMS, frontdoor account, eu-west-2 | The key that wraps the private keys. Retained, with rotation of its own key material on. Its [policy](#the-signing-keys-policy) says who may use it |
| `frontdoor-<environment>-caller-token-private-keys` | DynamoDB, frontdoor account, eu-west-2 | An item for each key rotation holds: `keyId`; `privateKey`, the private key as KMS encrypted it; `activeFrom`, when it starts; and, once its successor is scheduled, `activeUntil`, when it stops. Times are in seconds since the epoch. The edge reads it |
| `frontdoor-<environment>-caller-token-public-keys` | DynamoDB, frontdoor account, eu-west-2 | An item for each key rotation holds: `keyId`, `publicKey`, as KMS returned it, in DER, and the same times. In a revoked key's place, for a day, its `keyId` and `revokedAt`, when it was revoked. And the item `#version`, how many times rotation has changed the two tables. Every gateway reads it, through its network's [`dynamodb` endpoint](/flex-platform/infrastructure/network/#the-caller-tokens-keys) |

Each private key is encrypted with the encryption context `{ purpose: "flex-caller-token", kid }`.
A ciphertext decrypts only with the same context. So one key's ciphertext can never be passed off
as another's, and a role may be given decryption for this purpose alone.

No stack holds an item. Key rotation writes them. A template would put back what it last deployed
whenever it changed.

### The signing key's policy

The KMS key's policy leaves managing the key to IAM. Whatever a principal's own policy allows, the
key's policy denies:

- `kms:Decrypt` to anyone but the edge's role, `frontdoor-<environment>-edge`;
- `kms:Encrypt`, `kms:GenerateDataKey*` and `kms:ReEncrypt*` to anyone but key rotation's role,
  `frontdoor-<environment>-caller-token-key-rotation`;
- to key rotation's role, each of those but `kms:GenerateDataKeyPairWithoutPlaintext` and
  `kms:ReEncrypt*`, which are all it [uses](#permissions);
- `kms:ReEncrypt*` to anyone, unless it is onto the same key. So a private key is never encrypted
  again under a key someone else can use.

So a principal in the account can't decrypt a private key, even if its own policy allows
`kms:Decrypt` on every key. A deny grants nothing: each role's own policy still has to allow what
it does. The policy names both roles exactly, by the names their stacks create them with. Synth
refuses a role named by a pattern.

The policy names no role a deploy runs as, since the platform doesn't choose those. It denies
nothing that manages the key, so no deploy is ever locked out of it. That also means a principal
whose own policy allows `kms:PutKeyPolicy` can rewrite the policy. So who may do that in the
account matters as much as the policy.

### The tables

Each table is keyed by `keyId`. Each table's own policy lets its readers scan it. As
[every table's policy](/flex-platform/infrastructure/overview/#a-tables-policy) does, it also
denies:

- everything to anyone but key rotation's role and the table's readers, except managing the table;
- everything to a reader but a scan;
- everything to key rotation's role but its scans, puts and deletes.

Both tables are billed on demand, with point-in-time recovery. They are encrypted with DynamoDB's
own key, protected from deletion and retained.

The private keys table has one reader: the edge's role, `frontdoor-<environment>-edge`, in the
frontdoor account. The policy names it exactly, because a policy matches a role's ARN as a
pattern. Synth refuses a private keys reader whose ARN holds `*` or `?`.

The public keys are in one place, which every gateway in every domain account reads. So a key is
in every gateway's reach the moment rotation writes it. Adding a domain account adds nothing for
rotation to write.

The public keys table's readers are any role named `gateway-<environment>-*-execution`, the pattern
every gateway's role matches, in each domain account that runs a gateway. The policy names those
accounts as principals, and holds them to the pattern with an `aws:PrincipalArn` condition. It
can't name the roles, because a policy naming a role that doesn't exist yet is refused, and a
gateway's stack may deploy after it. It uses a pattern, not each gateway's role, so adding a
gateway leaves the policy as it is. The policy also never nears DynamoDB's limit on a policy's
size. A domain account only ever belongs to one environment, so the pattern reaches no other
environment's gateways. Each gateway's role grants itself the same scan, which is all it may do.
No other table lets in another account.

## Rotation

Key rotation is a Lambda function, `frontdoor-<environment>-caller-token-key-rotation`, in
eu-west-2. It makes, schedules and removes the keys. An EventBridge Scheduler schedule of the same
name runs it. Only one copy runs at a time. Each run does what is due and nothing more, so the
next run retries a run that fails.

| What | When |
|---|---|
| A run | Every 15 minutes, with no retry |
| The next key starts | Seven days after the current key started |
| The least notice of a key | An hour ahead |
| A replaced key leaves both tables | Five minutes after it is replaced |
| A revoked key's ID is kept | A day |
| The failure alarm goes off | When runs fail in two of the last three 15-minute periods |

The function's code is the same for any kind of key. Three things are particular to the caller
token's keys, as its policy: an Ed25519 key pair, the encryption context's purpose, and the timings
on this page.

A switch from one key to the next happens at a moment set when the next key is made:

1. **Scheduled.** If there is no next key, a run makes one. The new key starts seven days after the
   current key started, and the run keeps that moment as when the current key stops. A time that
   has passed never changes, so a key that has stopped signing never signs again. The run gives the
   new key to the edge and to the gateways in the same write. A key is never scheduled less than
   an hour ahead, even after the runs have stopped for longer than seven days. An hour is longer
   than an edge goes between reads, or a gateway keeps the public keys.
2. **Signing.** At that moment every edge signs with the new key, since each already holds it.
   Every gateway accepts it, since each already holds its public key. The key it replaces stops
   verifying a little over a minute later, when its last token expires.
3. **Removed.** Five minutes after a key is replaced, a run takes it out of both tables. The edge
   stopped signing with it at the switch.

Rotation needs no downtime. No edge or gateway has to read anything at the moment of a switch.

Before a run writes anything, it has KMS check every key the edge is to hold. That includes a key
it has just made and each key it made before. Its role can't decrypt a private key. So it asks KMS,
with `ReEncrypt`, to encrypt the key again under the same KMS key and context. KMS decrypts the key
to do it, and returns only a new ciphertext, which the run discards.

The run fails if a key was damaged, or doesn't decrypt as its key ID under the signing key:

- A key just made is then never kept, and the next run makes another.
- A key made before stops every run until it is [revoked](#revoking-a-key).

So rotation finds a key that can't be decrypted within 15 minutes, normally days before an edge
asks for it. See [when a run fails](#when-a-run-fails).

A run then writes every change to the two tables in one transaction. So neither table is ever
written without the other, and no edge holds a key a gateway can't read. If the transaction
fails, neither table changes, and a key the run made is never used. The next run starts again from
what the tables hold. A key is normally scheduled seven days ahead, so there are hundreds of runs
to do it in. A run with nothing due writes nothing.

The transaction refuses a run whose view of the tables is stale. Every transaction writes
`#version` one higher. It writes only if `#version` still holds the count the run read before it
read anything else. So if anything changed since the run read the tables, the run writes nothing,
and fails.

On an environment's first run, the first key starts at once, since no edge has signed anything
yet. The second run, 15 minutes later, schedules the next key. The schedule starts the first run
within 15 minutes of the caller token's stack deploying. Until then, the edge answers every signed
request with a 500. Nothing else starts a run, so the schedule is the one place keys are made.

### Revoking a key

To remove a key at once, invoke the function with `{ "revoke": "<kid>" }`. The function revokes
the key, then does a run like any other.

The revocation needs nothing but the tables. It reads them, then writes one transaction that:

- deletes the key's item from the private keys;
- writes its record in its item's place in the public keys;
- if it was the next key, clears the end on the key that was to hand over to it.

It asks nothing of KMS: it makes no key and checks none. So a key leaves both tables even if the
KMS key is disabled or throttled, another key fails its check, or no key can be made in its place.
The function then logs `key_revoked`.

The run then reads the tables again, as the revocation left them:

- If the edge was signing with the revoked key, no key signs. So the run makes a key that starts at
  once, and the key the revoked one replaced stays stopped.
- If it was the next key, none is scheduled. So the run schedules one for the same moment, or an
  hour ahead if that is later. The signing key stops when the new one starts.

If the run fails, the revocation stays, and the function fails, as for any
[failed run](#when-a-run-fails). Every run after it tries again. Until one succeeds, a revoked
signing key has no replacement. The edge has no key to sign with, and answers every signed request
with a 500.

A revocation can be run again with the same request, such as when the first one's answer was
lost. Rotation keeps the ID of each key it revokes for a day. So it knows the key, logs
`key_already_revoked`, changes nothing, and goes on to the run. If a key ID is neither held nor
revoked, the function fails and changes nothing.

Once the revocation has written the tables:

- a gateway refuses the revoked key within a minute;
- a gateway that can't read the tables refuses every token once five minutes have passed since its
  last read that worked;
- an edge stops signing with the key at its next read, normally within five minutes;
- an edge that can't read goes on signing with the key. Gateways refuse those tokens, as they
  refuse tokens signed by an edge that hasn't read its new key yet.

### When a run fails

The alarm `frontdoor-<environment>-caller-token-key-rotation-failed` goes off when runs fail in two
of the last three 15-minute periods. One failed run doesn't set it off, since the next run is the
retry. The function's log group, `/flex/frontdoor/<environment>/caller-token-key-rotation`, says
why.

The function logs a key that fails its check as `key_check_failed`. The line holds its `keyId`,
AWS's name for the error as `reason`, and `stored`: whether rotation held the key before this run.
A stored key passed the same check when it was made. So something has changed since: the private
keys table, or the KMS key.

| `reason` | Means | Do |
|---|---|---|
| `InvalidCiphertextException`, `IncorrectKeyException` | The private key rotation holds isn't what KMS encrypted for that key ID | [Revoke](#revoking-a-key) the key, which doesn't wait on the check. If it was stored, look in CloudTrail for a change to the private keys table's policy, which is what would let anything but rotation's role write to it |
| `DisabledException`, `KMSInvalidStateException` | The KMS key is disabled or scheduled for deletion, so no edge can decrypt either | Enable the KMS key, or cancel its deletion, and look in CloudTrail for who changed it. A key can still be revoked meanwhile, but none is made in its place until KMS answers |
| `AccessDeniedException` | The role's policy or the [KMS key's](#the-signing-keys-policy) no longer allows the check | Compare both with what the stack deploys |
| Throttling, or a timeout | KMS didn't answer | Nothing, unless every run says it |

The function logs any other failure as `key_rotation_failed`, with the AWS error's name and the
source locations. That includes:

- a run that found the tables holding anything it can't read, which writes nothing;
- a run whose view of the tables was stale;
- a run that KMS wouldn't make a key for, whose error has one of the names above.

After a [revocation](#revoking-a-key), the log says how far it got:

| The log holds | Means | Do |
|---|---|---|
| `key_revoked`, then a failure | The key is revoked, and the run after it failed. If the key was signing, no key signs | See to the failure, as above. The next run that succeeds makes or schedules the replacement, so nothing has to be invoked again |
| A failure, and no `key_revoked` before it | The revocation itself failed, and the key is still held | See to the failure, then invoke the revocation again. One whose view of the tables was stale only has to be invoked again |
| `key_already_revoked` | The key was revoked by an earlier invocation | Nothing |

### Permissions

The function's role, `frontdoor-<environment>-caller-token-key-rotation`, may:

- make key pairs only under the signing key, found by its alias, since KMS generates the key's ID,
  and only with the caller token's encryption context purpose;
- have KMS encrypt a private key again, only under that same key and with that purpose, which is
  how a run [checks](#rotation) one. It can't decrypt one. The
  [signing key's policy](#the-signing-keys-policy) denies it that, and every other way to encrypt
  with the key, whatever its own policy says;
- read its two tables, and put and delete their items;
- write to its own log group, `/flex/frontdoor/<environment>/caller-token-key-rotation`.

The schedule runs the function as its own role,
`frontdoor-<environment>-caller-token-key-rotation-schedule`. Only EventBridge Scheduler may assume
that role, for a schedule in the account's default group, and the role may only invoke the
function. Scheduler names a schedule's group, not the schedule, when it assumes a role.

The function logs each key it makes as `keyId`, with when it starts as `activeFrom`. It logs each
key it removes or revokes by key ID alone. It logs a revocation as soon as it is written, before
the run that follows it. A [failed run](#when-a-run-fails) logs why, and fails, so Lambda's error
metric counts it.

## Stacks

One stack, `frontdoor-<environment>-caller-token-keys`, in the frontdoor account in eu-west-2,
holds:

- the signing key and its alias;
- the [push ID's secret](#the-push-id) and its policy;
- key rotation's [tables](#the-tables), function, role, log group, schedule and alarm.

The stack is protected from deletion, and the key, the tables and the secret are retained.

A gateway's stack doesn't depend on it. A gateway finds the public keys table by name, and reads it
only when called.
