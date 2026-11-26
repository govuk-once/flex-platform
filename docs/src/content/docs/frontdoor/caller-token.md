---
title: The caller token
description: The token that says who a request is for, how the edge signs it and derives the push ID it holds, how gateways verify it, and how key rotation makes, schedules and removes its keys.
---

The caller token is the platform's statement of who a request is for. Lambda@Edge signs it and
sends it as `x-flex-secure`, a domain passes it on to the gateways it calls, and each gateway
verifies it before it acts. Any domain may call any gateway, so this is what keeps a domain to its
own caller's records: a gateway compares the fields an operation
[binds](/flex-platform/gateways/configuration/#secure-bindings) with the token's claims.

## The token

A compact JWS, signed with EdDSA over Ed25519:

| Part | Holds |
|---|---|
| Header | `alg: "EdDSA"`, `typ: "JWT"`, and `kid`, the [key](#keys) it was signed with |
| `pairwiseId` | The verified access token's `username` |
| `service` | The service the caller uses, whose namespace `pairwiseId` is in: One Login gives each service its own pairwise IDs. `"app"`, the one service the Frontdoor serves |
| `pushId` | The ID the caller's notifications are pushed to, [derived](#the-push-id) from `pairwiseId` |
| `aud` | `flex:<environment>:gateways`, the environment's gateways |
| `iat`, `exp` | When it was signed, and a minute later |
| `jti` | CloudFront's ID for the request, so each gateway call traces to the request that made it |

It holds nothing of the request itself, its method, path or host: the gateway never sees the
request, only what the domain sends it. Within its minute, a domain can use it for any number of
gateway calls, but only for that user.

## Signing

Lambda@Edge reads its signing keys from eu-west-2, wherever the copy runs. It reads the
[private keys table](#keys) from DynamoDB: every key rotation holds, each with the moment it starts
and, once the next key is scheduled, the moment it stops. It decrypts with KMS, with the key's
encryption context, each private key it doesn't already hold that hasn't stopped, and has started
or starts within the hour. Each call is signed with the function's own role and has 1.5 seconds. A
table that holds anything but keys, or that would take more than one read, is a read that fails:
the edge never signs from part of the table.

The next key is scheduled seven days ahead, and few copies that read it then are still running when
it starts. So a copy leaves it until its last hour, which is 12 reads, and the least notice
[rotation](#rotation) gives of a key.

It signs with the latest key that has started and not stopped. By then it holds the next key, so
every copy switches at the scheduled moment without a read. It reads the table again every five
minutes,
so a [revocation](#revoking-a-key) normally reaches every copy within five minutes, and calls KMS
only for a key it hasn't seen. A read that fails keeps the keys it has, however old, and isn't tried
again for 30 seconds. So an edge that can't read goes on signing with a revoked key, and every
gateway refuses what it signs.
With no key that has started, the request is the 500, and the next read waits 30 seconds too, so
DynamoDB isn't asked again by every request while it can't be reached. Requests that arrive while a
read is under way share it.

## The push ID

`pushId` is `base64url(HMAC-SHA256(pairwiseId))`, keyed with a secret that only the edge reads. The
same user has the same push ID in every token, and nobody without the secret can turn one ID into
the other.

The secret is `frontdoor-<environment>-push-id-secret`, in Secrets Manager in the frontdoor account
in eu-west-2. Its stack creates it empty, and a person puts its value, as text. The edge keys the
HMAC with every character of that text, never parsed and never trimmed. Until it has a value, every
request with a valid token is the edge's 500. A new value changes every user's push ID, so it is
put once and never rotated. The secret's own policy refuses a read by anything but the edge's
role, whatever else allows it.

Lambda@Edge reads the secret from eu-west-2, wherever the copy runs, while it loads its signing
keys. The call is signed with the function's own role and has 1.5 seconds. A copy reads it once,
and keeps it for as long as it runs, since the value never changes. While a read fails, or finds
the secret without a value, the request is the 500: no token is signed without the claim. The
read isn't tried again for 30 seconds, so a copy starts signing within 30 seconds of a person
putting the value. Requests that arrive while a read is under way share it.

## Verifying

A domain passes the token as the envelope's `secure.token`, through the
[gateway client](/flex-platform/domains/overview/#the-caller-context). The
[domain SDK](/flex-platform/domains/requests/#the-handlers-context) reads `pairwiseId` and `pushId`
from it for a handler, and has no need to verify it. The gateway verifies it as the second step of
[a request](/flex-platform/gateways/overview/#a-request), before it routes the call, so a caller
without a valid token learns nothing of the gateway's operations.

A call without a token is `UNAUTHENTICATED`: the domain didn't pass it on. A token that fails any
of these checks is `SECURE_SIGNATURE_INVALID`, and the log names the check, never a value from the
token:

- it is a compact JWS of three base64url parts, each written the one way an encoder writes it, of
  at most 4,096 characters;
- `alg` is `EdDSA`, and no `crit` header asks for anything more. The header never chooses how the
  token is checked;
- `kid` is a key ID's shape, checked before it is looked up, and names a key the gateway holds;
- the Ed25519 signature verifies;
- `aud` is the gateway's own environment's, `FLEX_CALLER_TOKEN_AUDIENCE`;
- `iat` and `exp` are numbers, the token lives a minute at most, wasn't issued in the future and
  hasn't expired, allowing the clocks 5 seconds either way;
- `iat` falls while the key signs: not before it started, and not after it stopped, allowing the
  same 5 seconds;
- `jti` has the shape of CloudFront's request IDs;
- each claim, `pairwiseId`, `service` and `pushId`, is a string that isn't empty. Only the token's own properties are read.

After it, every log line for the call holds `frontdoorRequestId`, the token's `jti`, which joins
it to the edge's line for the request. The token and its claims are never logged.

The gateway reads the public keys from the [public keys table](#keys), named by its ARN in
`FLEX_CALLER_TOKEN_KEYS_TABLE`, through its network's
[`dynamodb` endpoint](/flex-platform/infrastructure/network/#the-caller-tokens-keys), at the name in
`FLEX_CALLER_TOKEN_KEYS_ENDPOINT`, over HTTPS. It reads on the first call, and again after a minute, so a
revoked key is refused within a minute. A key ID it doesn't hold reads them again. It reads at
most once every ten seconds, so a caller can't make every call read them, and a store that can't
be reached isn't asked by every call either.

Each read scans the whole table, in one page: a table that would need a second isn't one rotation
keeps, and the read fails. Each key's item gives an Ed25519 public key, in DER, and the times it
signs between. A revoked key's record and `#version` hold no key, and are passed over. A table that
holds anything else, or a key of any other type, fails the read whole. So does a revoked key's
record that holds a key, which rotation's own read refuses too: an item is a key or the record of
one revoked, never both.

A read that fails keeps the keys it has, for five minutes from the last read that worked, which is
time for a failed read to be tried again many times. A key revoked in that time is one the gateway
can't know of, so after it the gateway refuses every token until a read works: each call is
`INTERNAL`, since no caller can have caused it. So is a call with no keys at all.

Each read that fails is logged as a warning, `The caller token's keys could not be read`, so a
table a gateway can't read shows in its log at once, not when calls fail five minutes later. The
line's `reason` is AWS's name for the error, such as `AccessDeniedException`, or, when the gateway
itself refused what the table held, one of `item_without_key_id`, `item_not_a_key`,
`revoked_item_with_key` and `more_than_one_page`. An error with no name of that kind is
`unnamed_error`. The line never holds the error's message, an item or a key.

Holding `iat` to the key's times is what lets a key go quickly. A token signed just before a switch
verifies for the rest of its minute. A token issued after it, by anyone holding the old private key,
fails, so the old key verifies nothing a little over a minute after the switch, whenever it leaves
the public keys. A key made ahead of its time verifies nothing before it starts.

Within its minute, a token can be used for any number of gateway calls, but only for its user.
The verifier is written on Node's `crypto` alone: it accepts one algorithm, so a library's choice
of algorithms would only be more to keep shut.

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
| `alias/frontdoor-<environment>-caller-token` | KMS, frontdoor account, eu-west-2 | The key that wraps the private keys. Retained, with rotation of its own key material on. Its [policy](#the-signing-keys-policy) says who may use it |
| `frontdoor-<environment>-caller-token-private-keys` | DynamoDB, frontdoor account, eu-west-2 | An item for each key rotation holds: `keyId`; `privateKey`, the private key as KMS encrypted it; `activeFrom`, when it starts; and, once its successor is scheduled, `activeUntil`, when it stops. Times are in seconds since the epoch. The edge reads it |
| `frontdoor-<environment>-caller-token-public-keys` | DynamoDB, frontdoor account, eu-west-2 | An item for each key rotation holds: `keyId`, `publicKey`, as KMS returned it, in DER, and the same times. In a revoked key's place, for a day, its `keyId` and `revokedAt`, when it was revoked. And the item `#version`, how many times rotation has changed the two tables. Every gateway reads it, through its network's [`dynamodb` endpoint](/flex-platform/infrastructure/network/#the-caller-tokens-keys) |

Each private key is encrypted with the encryption context `{ purpose: "flex-caller-token", kid }`.
A ciphertext decrypts only with the same context, so one key's ciphertext can never be passed off
as another's, and a role may be given decryption for this purpose alone.

No stack holds an item: key rotation writes them, and a template would put back what it last
deployed whenever it changed.

### The signing key's policy

The KMS key's policy leaves managing the key to IAM, and denies, whatever a principal's own policy
allows:

- `kms:Decrypt` to anyone but the edge's role, `frontdoor-<environment>-edge`;
- `kms:Encrypt`, `kms:GenerateDataKey*` and `kms:ReEncrypt*` to anyone but key rotation's role,
  `frontdoor-<environment>-caller-token-key-rotation`;
- to key rotation's role, each of those but `kms:GenerateDataKeyPairWithoutPlaintext` and
  `kms:ReEncrypt*`, which are all it [uses](#permissions);
- `kms:ReEncrypt*` to anyone unless it is onto the same key, so a private key is never encrypted
  again under a key someone else can use.

So a principal in the account whose own policy allows `kms:Decrypt` on every key can't decrypt a
private key. A deny grants nothing: each role's own policy still has to allow what it does. Both
roles are named exactly, by the names their stacks create them with, and one named by a pattern is
refused at synth.

The policy names no role a deploy runs as, which the platform doesn't choose, and denies nothing
that manages the key, so no deploy is ever locked out of it. That also means a principal whose own
policy allows `kms:PutKeyPolicy` can rewrite it, so who may do that in the account matters as much
as the policy.

### The tables

Each table is keyed by `keyId`. Each table's own policy lets its readers scan it, and, as
[every table's policy](/flex-platform/infrastructure/overview/#a-tables-policy) does, denies:

- everything to anyone but key rotation's role and the table's readers, except managing the table;
- everything to a reader but a scan;
- everything to key rotation's role but its scans, puts and deletes.

Both tables are billed on demand, with point-in-time recovery, encrypted with DynamoDB's own key,
protected from deletion and retained.

The private keys' one reader is the edge's role, `frontdoor-<environment>-edge`, in the frontdoor
account. It is named exactly: a policy matches a role's ARN as a pattern, so a private keys reader
whose ARN holds `*` or `?` is refused at synth.

The public keys are in one place, which every gateway in every domain account reads, so a key is
in every gateway's reach the moment rotation writes it, and adding a domain account adds nothing
for rotation to write. Their readers are any role named `gateway-<environment>-*-execution`, the
pattern every gateway's role matches, in each domain account that runs a gateway. The policy names
those accounts as principals and holds them to the pattern with an `aws:PrincipalArn` condition,
because a policy naming a role that doesn't exist yet is refused, and a gateway's stack may deploy
after it. A pattern, not each gateway's role, so adding a gateway leaves the policy as it is, and
it never nears DynamoDB's limit on a policy's size. A domain account is only ever one environment's,
so the pattern reaches no other environment's gateways. Each gateway's role grants itself the same
scan, which is all it may do. No other table lets in another account.

## Rotation

Key rotation is a Lambda function, `frontdoor-<environment>-caller-token-key-rotation`, in
eu-west-2. An EventBridge Scheduler schedule of the same name runs it every 15 minutes, with no
retry. Each run does what is due and nothing more, so a run that fails is simply retried by the
next. Only one copy runs at a time.

Its code is the same for any kind of key. What is particular to the caller token's is its policy:
an Ed25519 key pair, the encryption context's purpose, and the timings on this page.

A switch from one key to the next is a moment, set when the next key is made:

1. **Scheduled.** When there is no next key, a run makes one, to start seven days after the current
   key started, and keeps that moment as when the current key stops. A time that has passed never
   changes, so a key that has stopped signing never signs again. The new key is given to the edge
   and to the gateways in the same write. A key is never scheduled less than an hour ahead, longer than an edge goes between reads or a gateway
   keeps the public keys, even after the runs have stopped for longer than seven days.
2. **Signing.** At that moment every edge signs with it, since each already holds it,
   and every gateway accepts it, since each already holds its public key. The key it replaces stops
   verifying a little over a minute later, when its last token expires.
3. **Removed.** Five minutes after a key is replaced, a run takes it out of both tables. The edge
   stopped signing with it at the switch.

Rotation needs no downtime, and no edge or gateway has to read anything at the moment of a switch.

Before a run writes anything, it has KMS check every key the edge is to hold: one it has just
made, and each it made before. Its role can't decrypt a private key, so it asks KMS to encrypt the
key again under the same KMS key and context, with `ReEncrypt`. KMS decrypts the key to do it and
returns only a new ciphertext, which the run discards. A key that was damaged, or doesn't decrypt
as its key ID under the signing key, fails the run. A key just made is then never kept, and the
next run makes another. A key made before stops every run until it is
[revoked](#revoking-a-key). So a key that can't be decrypted is found within 15 minutes, normally
days before an edge asks for it. See [when a run fails](#when-a-run-fails).

A run then writes every change to the two tables in one transaction, so neither is ever written
without the other, and no edge holds a key a gateway can't read. If the transaction fails, neither
table changes, a key the run made is never used, and the next run starts again from what they
hold. A key is normally scheduled seven days ahead, so there are hundreds of runs to do it in. A
run with nothing due writes nothing.

The transaction refuses a run whose view of the tables is stale. Every transaction writes
`#version` one higher, and only if it is still the count the run read before it read anything
else, so a change made since the run read the tables makes it write nothing, and fail.

On an environment's first run, the first key is made to start at once, since no edge has signed
anything yet. The second run, 15 minutes later, schedules the next key. Until the
first run, which the schedule starts within 15 minutes of the caller token's stack deploying, every
signed request is the edge's 500. Nothing else starts a run, so the schedule is the one place keys
are made.

### Revoking a key

To remove a key at once, invoke the function with `{ "revoke": "<kid>" }`. The function revokes
the key, then does a run like any other.

The revocation needs nothing but the tables. It reads them, and writes one transaction: the key's
item deleted from the private keys, its record written in its item's place in the public keys, and,
if it was the next key, the end cleared on the key that was to hand over to it. It asks nothing of
KMS: it makes no key and checks none. So a key leaves both tables while the KMS key is disabled or
throttled, while another key fails its check, and while no key can be made in its place. The
function then logs `key_revoked`.

The run reads the tables again, as the revocation left them. If the edge was signing with the
revoked key, no key signs, so the run makes one that starts at once, and the key the revoked one
replaced stays stopped. If it was the next key, none is scheduled, so the run schedules one for
the same moment, or an hour ahead if that is later, and the signing key stops when the new one
starts.

If the run fails, the revocation stays, and the function fails, as for any
[failed run](#when-a-run-fails). Every run after it tries again. Until one succeeds, a revoked
signing key has no replacement: the edge has no key to sign with, and every signed request is its
500.

A revocation can be run again with the same request, such as when the first one's answer was
lost. Rotation keeps the ID of each key it revokes for a day, so it knows the key, logs
`key_already_revoked`, changes nothing, and goes on to the run. A key ID it neither holds nor has
revoked fails the function, changing nothing.

Once the revocation has written the tables, a gateway refuses the revoked key within a minute. One
that can't read them refuses every token once five minutes have passed since its last read that
worked. An edge stops signing with the key at its next read, normally within five minutes. One that
can't read goes on signing with it, and gateways refuse those tokens, as they refuse tokens signed
by an edge that hasn't read its new key yet.

### When a run fails

The alarm `frontdoor-<environment>-caller-token-key-rotation-failed` goes off when runs fail in two
of the last three 15-minute periods. One failed run doesn't set it off, since the next run is the
retry. The function's log group, `/flex/frontdoor/<environment>/caller-token-key-rotation`, says
why.

A key that fails its check is logged as `key_check_failed`, with its `keyId`, AWS's name for the
error as `reason`, and `stored`: whether rotation held the key before this run. A stored key passed
the same check when it was made, so something has changed since: the private keys table, or the
KMS key.

| `reason` | Means | Do |
|---|---|---|
| `InvalidCiphertextException`, `IncorrectKeyException` | The private key rotation holds isn't what KMS encrypted for that key ID | [Revoke](#revoking-a-key) the key, which doesn't wait on the check. If it was stored, look in CloudTrail for a change to the private keys table's policy, which is what would let anything but rotation's role write to it |
| `DisabledException`, `KMSInvalidStateException` | The KMS key is disabled or scheduled for deletion, so no edge can decrypt either | Enable the KMS key, or cancel its deletion, and look in CloudTrail for who changed it. A key can still be revoked meanwhile, but none is made in its place until KMS answers |
| `AccessDeniedException` | The role's policy or the [KMS key's](#the-signing-keys-policy) no longer allows the check | Compare both with what the stack deploys |
| Throttling, or a timeout | KMS didn't answer | Nothing, unless every run says it |

Any other failure is logged as `key_rotation_failed`, with the AWS error's name and the source
locations. So is a run that found the tables holding anything it can't read, which writes nothing,
a run whose view of the tables was stale, and a run that KMS wouldn't make a key for, whose error
has one of the names above.

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
  how a run [checks](#rotation) one. It can't decrypt one, and the
  [signing key's policy](#the-signing-keys-policy) denies it that, and every other way to encrypt
  with the key, whatever its own policy says;
- read its two tables, and put and delete their items;
- write to its own log group, `/flex/frontdoor/<environment>/caller-token-key-rotation`.

The schedule runs it as its own role, `frontdoor-<environment>-caller-token-key-rotation-schedule`,
which only EventBridge Scheduler may assume, for a schedule in the account's default group, and
which may only invoke the function. Scheduler names a schedule's group, not the schedule, when it
assumes a role.

It logs each key it makes, as `keyId`, with when it starts, as `activeFrom`, and each it removes or
revokes, by key ID alone. A revocation is logged as soon as it is written, before the run that
follows it. A [failed run](#when-a-run-fails) logs why, and fails, so Lambda's error metric counts
it.

## Stacks

One stack, `frontdoor-<environment>-caller-token-keys`, in the frontdoor account in eu-west-2,
holds the signing key and its alias, the [push ID's secret](#the-push-id) and its policy, and key
rotation's [tables](#the-tables), function, role, log group, schedule and alarm. It is protected
from deletion, and the key, the tables and the secret are retained.

A gateway's stack doesn't depend on it: a gateway finds the public keys table by name, and reads it
only when called.
