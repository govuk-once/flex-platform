---
title: Releasing a domain
description: How a domain's pipeline uploads its code under a version, asks for its release, and follows the release to the end.
---

A domain's code is uploaded once, as a bundle, and released from the bucket that keeps it. Each
environment's `release` in config says how code reaches that environment:

- `"publish"`, if new code enters the stage there;
- `{ promoteFrom }`, naming the environment whose released code it takes.

In platform-prod, `development` publishes, `staging` promotes from `development`, and `production`
promotes from `staging`. Only the repository that a domain's definition names can release it.

In an environment that publishes, the domain's pipeline [uploads a bundle](#uploading-a-bundle) and
then [asks for its release](#releasing-a-bundle). It does both through the
[pipeline API](/flex-platform/domains/release-pipeline/#the-pipeline-api). Promotion, which takes released code from one environment to the
next, is planned.

This page is what a domain's pipeline does. How the platform carries a release out is in
[The release pipeline](/flex-platform/domains/release-pipeline/).

## Before the first release

- The domain's definition in config names its repository. See
  [declaring a domain](/flex-platform/domains/hosting/#declaring-a-domain).
- The repository has a GitHub environment named for each of the platform's environments it
  releases to. A job reaches the pipeline API for an environment only when it runs in the GitHub
  environment of that name. The repository's own protection rules for it decide which jobs may.
  See [what the API checks](/flex-platform/domains/release-pipeline/#what-the-api-checks).

The pipeline holds no AWS credentials. A job proves which repository it runs in with the token
GitHub issues it. The job asks for the token with the API's address, `https://<shared zone>/ci`, as
its audience. It sends the token alone as `x-flex-ci-token`, not as `Authorization`, because
CloudFront signs each request for the API and that header holds CloudFront's signature.

## Versions

A domain names each bundle it uploads with a version. The version is `MAJOR.MINOR.PATCH`, as
semantic versioning writes one, and nothing more:

- Each part is digits, with no leading zero (`0` itself is allowed), and at most nine of them.
- There is no `v` prefix.
- There is no pre-release, such as `-rc.1`, and no build metadata, such as `+abc`.

Versions compare part by part, as numbers, so `1.10.0` comes after `1.9.0`. The check and the
comparison are in `bundle-version.ts` in `shared/release`.

The domain chooses the version, and the platform holds the domain to it. A version names one
bundle, so a build that makes different bytes can't re-run a version. Build the zip so that the
same sources give the same bytes: the same entry order, and fixed file times. A version belongs to
the domain, not to an environment, so a domain releases from one line of history. A branch that
uploaded a version would hold that version for good.

## Uploading a bundle

A domain's code is uploaded as one zip, its bundle, under a [version](#versions), in two requests.
First, the pipeline asks the API where to send the bundle, and says what it will send:

```http
POST /ci/environments/<environment>/domains/<domain>/uploads
content-type: application/json
x-flex-ci-token: <the job's token>
x-amz-content-sha256: <this body's SHA-256>

{
  "version": "<the version, such as 1.4.2>",
  "sha256": "<the zip's SHA-256, in lowercase hex>",
  "size": <the zip's length in bytes>
}
```

The API, in order:

1. **Claims the version** for the bundle, in the [artefacts table](/flex-platform/domains/release-pipeline/#the-artefacts-table), unless
   the version is recorded already.
2. **Refuses a version recorded with another bundle,** with a 409,
   `This version is already a different bundle`. Once a version is recorded, it never names
   another bundle. So a pipeline that didn't change its version finds out here.
3. **Answers that there is nothing to upload** if the bundle is in the bucket already. An earlier
   run of the same version may have uploaded it, or another version with the same bytes:

   ```json
   { "version": "<the version>", "sha256": "<the zip's SHA-256>", "uploaded": true }
   ```

4. **Signs the upload** otherwise.

The API claims the version before it signs the upload, because it never sees the upload finish. So
a version can be claimed with no bundle behind it, by a run that stopped before its upload. A run
with the same bytes completes it, by the same steps. The run and commit recorded are the first
run's. A later upload of the same version and bundle changes nothing.

A signed upload is one request the pipeline may make of S3:

```json
{
  "uploaded": false,
  "method": "PUT",
  "url": "https://<bucket>.s3.eu-west-2.amazonaws.com/<domain>/bundle/<sha256>.zip?X-Amz-...",
  "headers": {
    "if-none-match": "*",
    "x-amz-checksum-sha256": "<the zip's SHA-256, in base64>"
  },
  "expiresInSeconds": 300
}
```

Send the zip to `url` with those headers, within five minutes. The address carries the signature
of the API's own role, so the pipeline needs no AWS credentials. The signature is good for that one
request. It covers three headers, and S3 refuses an upload that differs in any of them:

- **`content-length`,** the size the pipeline gave, so S3 accepts no other length.
- **`x-amz-checksum-sha256`,** the hash the pipeline gave. S3 checks the body against it, so the
  object under a key is the bundle the key names.
- **`if-none-match: *`,** so S3 writes only if there is no object. If the bundle is already there,
  S3 answers with a 412, and a pipeline takes that as done. The key is the bundle's hash, so what
  is there is the same bundle.

## Releasing a bundle

Once its bundle is uploaded, the pipeline asks for its release by its version:

```http
POST /ci/environments/<environment>/domains/<domain>/releases
content-type: application/json
x-flex-ci-token: <the job's token>
x-amz-content-sha256: <this body's SHA-256>

{ "version": "<the version, such as 1.4.2>" }
```

The API reads the version from the [artefacts table](/flex-platform/domains/release-pipeline/#the-artefacts-table), under the domain the
pipeline was allowed for. So a pipeline can release only its own domain's code. The API then looks
for the bundle the version names, `<domain>/bundle/<sha256>.zip`. A version is claimed before its
bundle is uploaded, so the bundle may never have arrived. If either is missing, the API answers
with a 409, `No bundle with this version has been uploaded`.

Otherwise, the API:

1. records the release in the [release table](/flex-platform/domains/release-pipeline/#the-release-table), with the version, the bundle's
   hash and its object's S3 version;
2. puts the release's key on the [release worker](/flex-platform/domains/release-pipeline/#the-release-worker)'s queue;
3. answers 202 with the release's ID:

```json
{
  "releaseId": "<the release's ID>",
  "environment": "<environment>",
  "domain": "<domain>",
  "version": "<the version>",
  "sha256": "<the zip's SHA-256>"
}
```

The release is queued, not done. Each request is a release of its own. Asking again for the
version already on `live` publishes no new function version and leaves `live` where it is, unless
the configuration the platform sets has changed. If the queue refuses the message, the API records
the release `refused`, at the step `queue`, and answers with a 500. No message is behind the
release, so it will never be tried, and the pipeline asks again.

## How a release went

The pipeline asks how a release went by its ID:

```http
GET /ci/environments/<environment>/domains/<domain>/releases/<release ID>
x-flex-ci-token: <the job's token>
```

The API reads the release from the [release table](/flex-platform/domains/release-pipeline/#the-release-table), under the environment and
domain the pipeline was allowed for. So a pipeline sees only its own domain's releases. The API
answers 200, with `cache-control: no-store`, because the record changes as the release goes:

```json
{
  "releaseId": "<the release's ID>",
  "environment": "<environment>",
  "domain": "<domain>",
  "version": "<the version>",
  "sha256": "<the zip's SHA-256>",
  "status": "released",
  "requestedAt": "2027-01-15T08:00:00.000Z",
  "updatedAt": "2027-01-15T08:01:30.000Z",
  "attempts": 1,
  "functionVersion": "3",
  "created": false,
  "moved": true,
  "runId": "<GitHub's ID for the run>",
  "commit": "<the commit>"
}
```

`status` is one of the statuses [below](#what-each-status-means). A release that stopped has
`step` and `reason` in place of `functionVersion`, `created` and `moved`. For example, a release
[`live` is ahead of](/flex-platform/domains/release-pipeline/#the-order-of-releases) has `check-order` and `superseded`. `runId` and
`commit` are there if the token that asked held them. A pipeline waits for `released`, `refused`
or `abandoned`, and asks again until then.

The API answers in any environment, publishing or not, because every release is recorded. It
answers with a 404, `Not found`, for an ID that isn't a release ID, or that names no release the
table holds for that domain there. It also answers 404 for a release recorded before releases had
versions, which the API can't read.

### What each status means

- `queued`: the API recorded the release and queued it.
- `releasing`: the release worker has claimed it. An attempt is running, or stopped without
  recording how it went, and the queue will deliver it again.
- `released`: `live` points at the release's function version.
- `failed` will be tried again.
- `refused` never will be, because nothing about the release would change.
- `abandoned` was tried as often as the queue tries, and won't be tried again. The pipeline asks
  again instead.

`released` never changes. `refused` is never tried again, but an attempt already running can
still record `released` over it, because Lambda says what is live. `abandoned` can change too,
because the worker still runs a release its queue gives it. See
[the dead-letter worker](/flex-platform/domains/release-pipeline/#the-dead-letter-worker).

## Releasing one at a time

A release that would put `live` behind where it already is, by its version or by when it was asked
for, is refused as `superseded`. See
[the order of releases](/flex-platform/domains/release-pipeline/#the-order-of-releases).

A domain's pipeline should still release one at a time in each environment, with a GitHub
`concurrency` group. A late release of an earlier version is refused, but it is still a wasted
release. A version released by mistake, such as `99.0.0`, makes the worker refuse every earlier
version from the pipeline until a later one is released.
