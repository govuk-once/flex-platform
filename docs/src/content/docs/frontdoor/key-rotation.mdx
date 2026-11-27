---
title: Key rotation
description: How the caller token's keys are made, scheduled, removed and revoked, and what to do when a run fails.
---

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

The function's code is the same for any kind of key. What is particular to the caller token's
keys is its key policy, `CALLER_TOKEN_POLICY` in `frontdoor/key-rotation`: an Ed25519 key pair, the
encryption context's purpose, and the timings on this page.

## A switch

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

## Checking the keys

Before a run writes anything, it has KMS check every key the edge is to hold. That includes a key
it has just made and each key it made before. Its role can't decrypt a private key. So it asks KMS,
with `ReEncrypt`, to encrypt the key again under the same KMS key and context. KMS decrypts the key
to do it, and returns only a new ciphertext, which the run discards.

The run fails if a key was damaged, or doesn't decrypt as its key ID under the signing key:

- A key just made is then never kept, and the next run makes another.
- A key made before stops every run until it is [revoked](#revoking-a-key).

So rotation finds a key that can't be decrypted within 15 minutes, normally days before an edge
asks for it. See [when a run fails](#when-a-run-fails).

## Writing the tables

A run then writes every change to the two tables in one transaction. So neither table is ever
written without the other, and no edge holds a key a gateway can't read. If the transaction
fails, neither table changes, and a key the run made is never used. The next run starts again from
what the tables hold. A key is normally scheduled seven days ahead, so there are hundreds of runs
to do it in. A run with nothing due writes nothing.

The transaction refuses a run whose view of the tables is stale. Every transaction writes
`#version` one higher. It writes only if `#version` still holds the count the run read before it
read anything else. So if anything changed since the run read the tables, the run writes nothing,
and fails.

## The first run

On an environment's first run, the first key starts at once, since no edge has signed anything
yet. The second run, 15 minutes later, schedules the next key. The schedule starts the first run
within 15 minutes of the caller token's stack deploying. Until then, the edge answers every signed
request with a 500. Nothing else starts a run, so the schedule is the one place keys are made.

## Revoking a key

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

## When a run fails

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
| `AccessDeniedException` | The role's policy or the [KMS key's](/flex-platform/frontdoor/caller-token/#the-signing-keys-policy) no longer allows the check | Compare both with what the stack deploys |
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

## Permissions

The function's role, `frontdoor-<environment>-caller-token-key-rotation`, may:

- make key pairs only under the signing key, found by its alias, since KMS generates the key's ID,
  and only with the caller token's encryption context purpose;
- have KMS encrypt a private key again, only under that same key and with that purpose, which is
  how a run [checks](#checking-the-keys) one. It can't decrypt one. The
  [signing key's policy](/flex-platform/frontdoor/caller-token/#the-signing-keys-policy) denies it that, and every other way to encrypt
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
