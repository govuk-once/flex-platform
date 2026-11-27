---
title: The release pipeline
description: How the platform carries out a domain's release, from the pipeline API through the release worker to the function's live alias.
---

[Releasing a domain](/flex-platform/domains/releasing/) is what a domain's pipeline does. This page
is how the platform carries it out, in the stage's shared account: the pipeline API, the bucket and
tables it records in, and the workers that release.

## The pipeline API

A domain's pipeline uploads and releases its code through an API of the platform's, never through
AWS itself, so it holds no AWS credentials. The API answers under `/ci`, at the apex of the stage's
shared zone, behind a CloudFront distribution of its own.

### The distribution

Each stage has one distribution, in its shared account. `ManagementEdge` in `shared/infra` builds
it from the constructs [the Frontdoor's](/flex-platform/frontdoor/overview/#the-distribution) is
built from. It has the same TLS policy, sets the same security
[headers on every response](/flex-platform/frontdoor/overview/#response-headers), has the same
[web ACL rules](/flex-platform/frontdoor/overview/#waf), and caches nothing. Three things differ:

- **The rate limits.** One token may make 100 requests in five minutes, and one address 500. The
  token's limit counts the exact value of `x-flex-ci-token`. The web ACL keeps that header out of
  its logs and samples.
- **The origin.** Every path goes to the API's function, at its Lambda function URL. Only
  CloudFront may call the URL from outside the shared account, as for any
  [function behind CloudFront](/flex-platform/infrastructure/overview/#a-function-behind-cloudfront).
  The function relies on the token it verifies, never on where a request came from.
- **What the origin sees.** It sees every header the caller sent except `host`, and the
  `x-correlation-id` the CloudFront Function set. It sees no cookie or query string. The function
  URL answers only to its own host. The headers aren't held to a list, because CloudFront refuses
  `x-amz-content-sha256` in one, and signs with it.

Its access logs, the web ACL's logs and the function's logs go to log groups in us-east-1, as
[the Frontdoor's](/flex-platform/frontdoor/overview/#logs) do.

### The first check

A CloudFront Function, `shared-management-viewer-request`, checks each request's structure as it
arrives, after WAF. Its code is in `shared/viewer-request`. It checks a request as
[the Frontdoor's](/flex-platform/frontdoor/cloudfront-function/) does. It shares the Frontdoor's
code for each check they have in common, with the same ID,
[rejections](/flex-platform/frontdoor/cloudfront-function/#rejections) and
[log line](/flex-platform/frontdoor/cloudfront-function/#logs). It verifies no signature:
[the API does that](#what-the-api-checks). In order, the function:

1. **Gives the request its ID,** as `x-correlation-id`. It removes any trace context, and every
   `x-flex-` header the caller sent except the token's.
2. **Checks the method.** Only `GET` and `POST` pass. It answers anything else with a 405 and an
   `Allow` header.
3. **Checks the token's shape,** before it looks at the path. It answers a failure with a 401. The
   token must meet all of these:
   - `x-flex-ci-token` appears once, and holds one token of at most 8 KB.
   - The token is three base64url segments, each written the one way its bytes encode.
   - The header and payload are JSON objects.
   - `alg` is `RS256`, `iss` is GitHub Actions' issuer, and `aud` is the API's address.
   - `exp` is a finite time in the future.
4. **Checks the path.** It must be under `/ci/`, with no empty or dot segment and no encoded `/`,
   `\` or `.`. It answers anything else with a 404. The API decides which paths it serves.
5. **Checks the content type** of a `POST`. The body must be `application/json`. It answers
   anything else with a 415.
6. **Checks the body's hash is there,** for a `POST`. `x-amz-content-sha256` must appear once, as
   64 lowercase hex digits. It answers anything else with a 400, `Bad request`. CloudFront can't
   hash a body, so it signs the hash the caller sends, and the API's origin refuses a body with any
   other hash. A `GET` has no body, and CloudFront signs it with none.

`buildViewerRequestFunction` bakes the issuer and the audience into the function, as the
Frontdoor's function has [its issuers](/flex-platform/frontdoor/cloudfront-function/#building-the-function)
baked in.

### What the API checks

The API is one Lambda function, `shared-ci`, in eu-west-2. Its code is in `shared/ci`. For each
request, in order, it:

1. **Verifies the token.** It answers a failure with a 401. It checks that:
   - the signature verifies against the keys GitHub publishes;
   - the token is in the one encoding the CloudFront Function accepts;
   - `iss` is GitHub Actions' issuer, `aud` is the API's address and `alg` is `RS256`;
   - `exp` is present and in the future, and `nbf`, if present, has passed;
   - `repository_id` and `repository_owner_id` are each digits.

   It fetches the keys, keeps them for 10 minutes and fetches them again, as
   [Lambda@Edge keeps its issuers'](/flex-platform/frontdoor/lambda-edge/#verifying-the-token). If
   a request needs keys the function can't fetch, it answers with a 500, never a pass.
2. **Finds the route.** It answers a path that matches no route with a 404. It answers a route's
   path with a method the route doesn't take with a 405, and an `Allow` header naming the methods
   it does take. Both come after the token, so a caller without one learns nothing of the routes.
   There are three:
   - `POST /ci/environments/<environment>/domains/<domain>/uploads`
   - `POST /ci/environments/<environment>/domains/<domain>/releases`
   - `GET /ci/environments/<environment>/domains/<domain>/releases/<release ID>`

   Each route is a method, a path and its handler, in `shared/ci/src/function/routes/`. Every
   route's path names an environment and a domain, and the router refuses to start with one that
   doesn't.
3. **Decides whether this pipeline may act on that domain there.** The decision is the same for
   every route, so no route can leave it out. A caller of another kind gets a function of its own.
   Anyone with a GitHub repository can have GitHub sign a token for the API's address. So a
   verified token says only which repository's pipeline is calling. The pipeline is allowed if:
   - the stage has the environment, and the environment hosts the domain;
   - the token's `repository_id` and `repository_owner_id` are the ones the stage's
     [config](/flex-platform/infrastructure/overview/#config) holds for the domain. It checks both,
     so a repository transferred to another owner is no longer the one registered. A domain with no
     repository in config can't be released;
   - the token's `environment` is the path's. GitHub sets that claim only for a job that runs in
     the GitHub environment of that name, once the repository's own protection rules for it have
     passed. So a domain's repository has a GitHub environment named for each of the platform's
     environments it releases to. It decides there which jobs may reach each one.

   Nothing is decided by the token's `sub`, whose format a repository's admin can change. The API
   answers a refusal with a 403, the same whatever the reason. So a pipeline learns nothing of which
   environments and domains exist, or which repository a domain belongs to.
4. **Checks the environment publishes,** for an upload or a release. New code enters a stage only
   where an environment's `release` is `"publish"`. Anywhere else, the API answers with a 409,
   `This environment takes no uploads` or `This environment takes no releases`. The pipeline is
   allowed, so the API tells it why.
5. **Reads the body.** It reads the body only now, for a pipeline that is allowed. Either body holds
   nothing else, and the API answers anything else with a 400.
   - For an upload, the body is
     `{ "version": "<major.minor.patch>", "sha256": "<64 lowercase hex digits>", "size": <bytes> }`.
     It holds a [version](/flex-platform/domains/releasing/#versions), and a size from 1 byte to 250 MB, the most Lambda unzips a
     function's code to.
   - For a release, the body is `{ "version": "<major.minor.patch>" }`.
6. **Acts on the request.** For an upload, it claims the version, signs the upload, and answers 200
   with [where to send the bundle](/flex-platform/domains/releasing/#uploading-a-bundle). For a release, it queues the release of a
   bundle that was uploaded, and answers 202. See [releasing a bundle](/flex-platform/domains/releasing/#releasing-a-bundle). For a
   `GET` of a release, it answers with [how the release went](/flex-platform/domains/releasing/#how-a-release-went).

`buildCiFunction` bakes these into the function when the stage is synthesized:

- the issuer and the audience;
- the environments, and whether each publishes;
- each domain's repository;
- the bucket;
- the artefacts and release tables' names;
- the release queue's address.

So who may release a domain changes only with a change to config and a deploy of `shared-release`.

The function writes one log line for each request. The line holds what happened as a fixed code,
the request's trace ID and how long the request took. For a verified token, it also holds GitHub's
IDs for the repository, its owner and the workflow run, and the commit the job runs for. It logs
the environment and the domain only for a pipeline that was allowed, when they are names from
config. Each route adds more:

- An upload's line adds the version, the bundle's key and its size.
- A release's line adds the version. Once the API finds the bundle, it adds the bundle's key. For a
  queued release, it adds the object's S3 version.
- A release's status adds the release's ID, once it has a release ID's form, and where the table
  has the release.

The function never logs the token, or the address it signed an upload for. It never logs anything a
repository's admin can write, such as the repository's name or an environment's.

## The code bucket

The key is `<domain>/bundle/<sha256>.zip`. The domain is the one the pipeline was allowed for, so a
pipeline can write only under its own domain. The API's role may write and read keys of that shape,
and list the bucket, and do nothing else there. A signature carries no more than the signer's
permission, and covers its method. So no address the API signs can read or delete a bundle.

The bucket is `shared-domain-code-<account>`, in the stage's shared account. `DomainCodeBucket` in
`shared/infra` builds it. Its policy refuses, from anyone:

- a write by any role but the API's. A key is the bundle's hash only because the API signs each
  upload with that checksum. A write the API didn't sign could put other code under a bundle's key
  before the bundle is uploaded, and the bundle's own upload would then get a 412;
- a write that doesn't carry `If-None-Match`;
- a request on a presigned address signed more than five minutes before. So an address lasts no
  longer than the API says, even if the API signs for longer;
- any delete of an object or of a version of one;
- any change to the bucket's lifecycle rules, which could expire objects without a delete.

So under that policy, a key holds only the bundle it names. Once a bundle is uploaded, nothing
replaces or removes it. A released function's code stays in the bucket, so this also keeps the
function running.

The policy grants two reads of a bundle, by version, in each domain account of an environment that
publishes:

- Lambda may read a bundle for a domain's function. The statement names each account with
  `aws:SourceAccount`, and its functions, `domain-<environment>-*`, with `aws:SourceArn`.
- A domain's [deploy role](/flex-platform/domains/hosting/#permissions) may read a bundle, because Lambda reads the bundle a
  function is created or updated from as the caller. One statement names every such account, and
  its deploy roles, `domain-<environment>-*-deploy`, with `aws:PrincipalArn`. It names them this way
  because S3 refuses a policy that names a role that doesn't exist yet, and the domain stacks that
  create the roles deploy after this one.

Both statements name an account's domains by pattern, never one by one. So the policy grows with
the domain accounts, not with the domains. Each deploy role's own policy holds it to its domain's
bundles.

## The artefacts table

The API records each version a domain uploads in a DynamoDB table, `shared-release-artefacts`, in
the stage's shared account. `ArtefactTable` in `shared/infra` builds it. Each version is kept under
its domain, with partition key `domain`, and by its version, with sort key `version`. It holds:

| Attribute | Holds |
|---|---|
| `sha256` | The hash of the bundle the version names, in lowercase hex |
| `recordedAt` | When the API recorded it, in milliseconds |
| `runId`, `commit` | The run that recorded it, and its commit, if its token held them |

The API records a version once, with a put that succeeds only if there is none, and the version
never changes. The table's [policy](/flex-platform/infrastructure/overview/#a-tables-policy) denies
the API's role everything but getting and putting an item. It denies anyone else everything but
managing the table. So nothing changes or deletes a version. Like the
[release table](#the-release-table), the table is kept, with point-in-time recovery, if the stack
goes, and can't be deleted.

The bundle stays under its hash in the bucket, so two versions with the same bytes share one
object. The sort key is the version as text, which doesn't sort in version order.

## The release worker

A function in the shared account, `shared-release-worker`, does each release, so that the pipeline
API can answer at once. A first release creates a function in a VPC, which Lambda can take minutes
to make ready.

The API puts each release on a FIFO queue, `shared-release.fifo`, grouped by environment and
domain. So one domain's releases in an environment run one at a time, in the order they were asked
for, while other domains' releases run alongside. `ReleaseWorker` in `shared/infra` builds the
worker and the queue, and the worker's code is in `shared/release`.

### The release table

The release table is the record of each release request and how it went. The API records each
release in a DynamoDB table, `shared-releases`, before it queues it. The worker then records how
the release went.

Each release is kept under its domain in its environment, with partition key `target`
(`<environment>/<domain>`), and by its ID, with sort key `id`. The ID is a version 7 UUID. Its first
48 bits are the time the API made it. So the IDs sort in the order the releases were asked for, and
a domain's releases list newest first. Each release holds:

| Attribute | Holds |
|---|---|
| `environment`, `domain`, `version`, `sha256`, `versionId` | What was asked for: the [version](/flex-platform/domains/releasing/#versions), the bundle it names by its hash, and the S3 version of its object |
| `runId`, `commit` | The run that asked, and its commit, if its token held them |
| `status` | `queued`, `releasing`, `released`, `failed`, `refused` or `abandoned` |
| `requestedAt`, `updatedAt` | When the API recorded it, and when it last changed, in milliseconds |
| `attempts` | How many times the worker has claimed it |
| `step`, `reason` | For a release that stopped: the step, and a fixed code for why |
| `functionVersion`, `created`, `moved` | For a release that succeeded: the function version `live` points at, and whether the release created the function and moved `live` |

See [how a release went](/flex-platform/domains/releasing/#how-a-release-went) for what each status means.

Lambda, not the table, says what is deployed. The worker reads Lambda at each step, and the table
follows it. The table is retained, with point-in-time recovery, and has deletion protection on.

### Who can ask for a release

Only the pipeline API can ask, for a pipeline it has [allowed](#what-the-api-checks). But anything
that IAM lets invoke the worker can write its event, and a function's own policy holds no deny that
could refuse it. So a message holds only a release's key: its environment, domain and ID. The
worker releases what the table records under that key. Three rules hold this together:

- **Only the API records a release, and nothing changes what it asked for.** The table's
  [policy](/flex-platform/infrastructure/overview/#a-tables-policy) denies:
  - the API's role, `shared-ci`, everything but getting, putting and updating an item;
  - the workers' roles, `shared-release-worker` and `shared-release-dead-letter-worker`, everything
    but getting and updating an item;
  - anyone else everything but managing the table.

  So nothing deletes a release. The policy also denies, to every principal, an update that names
  `environment`, `domain`, `version`, `sha256`, `versionId`, `runId`, `commit` or `requestedAt`.
  So no writer can point a release at another domain or another bundle. If an update creates an
  item, the item has none of those attributes, so it isn't a release. The worker logs and drops a
  message that names no release in the table.
- **A final release isn't run again.** Before each attempt, the worker claims the release. It marks
  it `releasing` and counts the attempt, unless the release is final. So a repeated message, however
  it was sent, runs nothing that is released or refused. Any other release may be tried again, even
  while an attempt runs. Every step reads Lambda before it acts, so an attempt at something already
  done changes nothing. Lambda also refuses a change to a function it is still changing.
- **The queue takes messages only from the API, and gives them only to the worker.** Its policy
  denies, to every principal:
  - sending a message, unless the principal is `shared-ci`'s role;
  - taking a message, unless the principal is `shared-release-worker`'s role;
  - purging the queue;
  - moving messages out of either queue.

  Only the release queue may use the dead-letter queue, and no principal may send to it. SQS moves
  a message there itself.

No release from a pipeline can roll a domain back. See [the order of releases](#the-order-of-releases).

### The order of releases

The worker refuses a release that would put `live` behind where it already is. To know where `live`
is, it reads the alias's description, which names the release that set it and its version:

```
Set by release <release ID> at version <version>
```

The worker reads the description before anything changes. It reads it again just before it moves
`live`, in case another release moved it in the meantime. The first rule that applies decides:

| `live` | The release |
|---|---|
| Was set by this release | Is done, and recorded `released`, with `moved` false. |
| Was set by a release asked for later | Is refused as `superseded`. |
| Holds a later version | Is refused as `superseded`. |
| Holds the same version | Runs. The bundle is the same, so Lambda publishes nothing new unless the configuration the platform sets has changed, and `live` moves only if the function version did. This is how a change to what the platform sets reaches the code already on `live`. |
| Holds an earlier version, or none | Runs. |

"Asked for later" compares the time in each release's ID, to the millisecond and no further. The
rest of each ID is random. So two releases asked for in the same millisecond are in no order,
neither refuses the other, and the queue's order decides.

The two rules guard different things. The version holds a pipeline to the domain's order, so a
release of `1.2.0` that runs after `1.2.1` landed changes nothing. The time stops a release that
was asked for before another landed from running after it. This matters once something other than
a pipeline release, such as a rollback, can put an earlier version on `live`.

A domain's releases in an environment run one at a time, in the order they were asked for. A
release that fails holds back the ones after it until it succeeds or is given up. For example, if
`1.2.0` then `1.2.1` are asked for and `1.2.0` fails, the worker runs `1.2.0` until it succeeds or
is given up, and only then `1.2.1`. So the rules are for a release that comes back once a later one
is live. One example is a release that was [given up](#the-dead-letter-worker) and then named again
by an event the queue didn't send.

A superseded release is final. Its version stays in the [artefacts table](#the-artefacts-table) and
its bundle stays in the bucket. So a rollback, which is planned, could put the version on `live`
again.

A description in any other form refuses nothing. This covers every `live` alias set before releases
had versions, and any description written by hand. Anyone who could rewrite the description, with
`lambda:UpdateAlias` in the domain's account, could point `live` at any function version anyway. So
refusing such an alias would protect against nobody, and would stop the domain releasing.

### What a release does

For each release it claims, the worker:

1. **Assumes the domain's deploy role** in the domain account, and reads `live`. If `live` already
   names the release, the release is done. The worker records it `released`, with `live`'s function
   version, and changes nothing. If `live` is ahead of the release, the worker refuses it, by
   [the order of releases](#the-order-of-releases).
2. **Checks the bundle.** It reads the S3 version of the bundle's object that the API found, in
   full, and hashes it. The key names the bundle's hash. So the worker refuses an object with any
   other hash before it makes anything from it. As the deploy role, it also reads the isolated
   subnets and the `domain` security group from the network's parameters.
3. **Creates the function** the first time, and waits until it is active. Otherwise, it waits
   while Lambda is making or changing the function. Then it updates the function's configuration,
   waits, updates its code and waits again. Lambda refuses a change to a function it is still
   changing. The worker updates the function whatever state it settles in. An update reactivates
   a function that was idle long enough to become `Inactive`, and may mend one that `Failed`.
4. **Checks the code Lambda loaded.** Lambda's hash of the code, in base64, must match the
   bundle's, in hex, compared as bytes.
5. **Publishes a function version,** if the code still has that hash, and waits until it is active.
   A function version's description names the bundle and the commit it was built from. If the
   function's code and configuration haven't changed since its last function version, Lambda
   returns that function version. Its description then names the bundle and commit it was first
   published for.
6. **Points `live` at the function version.** It creates the alias the first time, and names the
   release and its version in the alias's description. Otherwise, it checks the order again, and
   moves the alias only from the revision it read. So it never overwrites a change made since.

Nothing reaches the new code until the last step.

An attempt has 15 minutes, the worker's timeout. Its waits share that time, less 30 seconds kept
back to move `live` and record how the attempt went. So a first create in a VPC, which Lambda can
take minutes to make ready, can use most of it. A wait that runs out fails the attempt.

A release sets the function's:

- name, `domain-<environment>-<name>`;
- role, `domain-<environment>-<name>-execution`;
- isolated subnets and `domain` security group. The deploy role refuses a configuration with no
  VPC, so a release sends them with every configuration update;
- logging, to `/flex/domain/<environment>/<name>/function`;
- `FLEX_ENVIRONMENT`, the environment's name. The code uses it only to build names, such as a
  gateway's function name, and never to choose what it does;
- tracing, active, so Lambda sends its traces to X-Ray;
- runtime, `nodejs26.x`, on arm64, with the handler `index.handler`, 1,024 MB of memory and a
  29-second timeout. A domain doesn't choose these. The timeout is how long the domain's API waits
  for the function, so a function never runs on after no one is waiting;
- code, the bundle's object by its S3 version. Lambda reads the code from the bucket in place and
  keeps no copy. So the bucket [lets Lambda read it](/flex-platform/domains/release-pipeline/#the-code-bucket) for as long as the
  function uses it.

The deploy role enforces the function's name, role and network. It doesn't enforce its logging,
environment or tracing, which only the release sets. A release that set another log group would
lose the function's logs, because the function's role may write to no other.

The worker records how each release went in the table:

| Outcome | Recorded | What happens next |
|---|---|---|
| A failure that might go differently next time, such as an AWS error | `failed` | The worker gives the message back to the queue, which delivers it again after 20 minutes. |
| Three failed attempts | | The queue moves the message to the dead-letter queue, `shared-release-dead-letter.fifo`, where the [dead-letter worker](#the-dead-letter-worker) gives it up. |
| A release that can never succeed, such as a bundle whose bytes aren't what its key says, or a release `live` is ahead of | `refused` | The worker drops the message. |

The worker records each outcome before it lets the message go. It records only over the claim it
made, so it never overwrites what another writer recorded since. `released` is the exception.
Lambda says what is live, so the worker records `released` over anything but `released`.

A worker that stops before it finishes, by running out of time or memory, records nothing. The
release stays `releasing`. The queue delivers the message again after 20 minutes, and the next
attempt picks up where Lambda shows the last one stopped.

The worker writes one log line for each attempt at a release, to `/flex/shared/release-worker`. The
line holds:

- what happened, as a fixed code;
- the queue's ID for the message;
- how long the attempt took;
- once the table holds the release: its ID, the environment, the domain, the version, the bundle's
  hash, GitHub's ID for the run and the commit.

A release that stopped adds the step and a reason. The reason is AWS's code for the error, such as
`AccessDeniedException`, or Lambda's code for a function that won't become ready, such as
`SubnetOutOfIPAddresses`. It is never a message. A release that succeeded adds the function
version, and whether the release created the function and moved `live`. The worker logs a
superseded release as `release_superseded`, at `INFO`, because a domain that releases quickly will
see it. It logs every other refusal as `release_refused`, at `ERROR`.

`buildReleaseWorker` builds the worker when the stage is synthesized. It builds it with each domain
the worker may release, and everything a release of that domain names. These are every domain with
a repository, in each environment that publishes. The worker's role may take the queue's messages,
read and change a release in the table, read bundles, and assume those domains' deploy roles. It
may do nothing else.

## The dead-letter worker

A function of its own, `shared-release-dead-letter-worker`, reads the dead-letter queue, so that
the release table says when no more attempts are coming. The release worker can't say so itself,
because an attempt that stopped with its function recorded nothing.

For each message, the dead-letter worker reads the release. Unless the release is final or given up
already, it records it `abandoned`, and keeps the step and reason its last attempt stopped at. It
logs `release_abandoned` with how many attempts there were. It leaves a release that is final or
given up already as it is. An attempt that is still running may yet release it. Lambda says what is
live, so the release worker records `released` over `abandoned`.

Anything that IAM lets invoke the function can write its event, and nothing in an event shows that
the queue gave the release up. So `abandoned` isn't final: the release worker still claims and runs
a release its queue gives it. If an event the queue didn't send gives a release up, the release is
still run, and the alarm is all that shows it was given up. A message that the queue really moves
to the dead-letter queue never returns to the release queue, because no principal may move one
back.

The dead-letter worker records first and lets the message go after. Lambda deletes a message only
once the function returns without giving it back. So if the function stops between the two, the
message comes again, and the second time the worker finds the release already `abandoned`. If the
table fails and the worker can't record a message, it gives the message back, and logs
`release_failed` at the step `abandon`. The dead-letter queue has no queue behind it. So such a
message comes again every two minutes, until the worker records it or the queue drops it after 14
days.

It is a separate function from the release worker, so that it needs none of the release worker's
access. Its role may take the dead-letter queue's messages and read and change a release, and
nothing else. The queue's policy denies taking a message to every other role. It has a 30-second
timeout. Lambda holds a queue's visibility timeout to at least its reader's timeout. So the
dead-letter queue's can be two minutes, rather than the release worker's 20.
`ReleaseDeadLetterWorker` in `shared/infra` builds it, and it logs to
`/flex/shared/release-dead-letter-worker`.

| Timing | Value |
|---|---|
| Release worker's timeout, for each attempt | 15 minutes, less 30 seconds kept back |
| Release queue's redelivery | after 20 minutes |
| Attempts before the dead-letter queue | 3 |
| Dead-letter worker's timeout | 30 seconds |
| Dead-letter queue's redelivery | every two minutes |
| Dead-letter queue's retention | 14 days |

### When a release is abandoned

Two alarms watch the dead-letter worker's log. They have no action until the platform has alerting.
Each counts lines of one event into the namespace `flex/shared/release`, and goes off on any line
in five minutes:

| Alarm | Goes off on | Means |
|---|---|---|
| `shared-release-abandoned` | `release_abandoned` | A release was given up. The table holds the step and reason its last attempt stopped at, and the release worker's log, `/flex/shared/release-worker`, has each attempt under the release's ID. |
| `shared-release-abandon-failed` | `release_failed` | A release couldn't be recorded as given up, so the table still says it may be tried. Its message is going round the dead-letter queue. |

The pipeline that asked sees `abandoned`. It can ask again once whatever stopped the release is put
right.
