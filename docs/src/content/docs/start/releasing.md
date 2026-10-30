---
title: Releasing packages
description: How the published packages are versioned, how candidates and releases are published, and how a release is prepared.
---

The packages domains install are published to GitHub Packages, in the `@govuk-once/` scope. Nothing
is published unless a release records it. A release is a pull request: `pnpm release` prepares it,
a person reviews it, and once it is merged the pipeline publishes it:

- **The client:** its final, as the release merges.
- **Each gateway's package:** a release candidate as the release merges, so it can be tried, and
  its final once production serves the gateway's schema.

Nothing is published from a laptop. `@repo/release`, in `packages/release`, does all of it.
`src/sources.ts` lists what is published:

| Package | Built by | Versioned | Final published |
|---|---|---|---|
| `@govuk-once/flex-gateway-client` | its `build` script, into `dist/` | declared | as the release merges |
| Each gateway's [client package](/flex-platform/codegen/overview/#the-client-package) | `codegen`, into `.gen/client/package/` | derived | at production |

A gateway's package is listed by being in `gateways/services/`, with nothing to add.

## Versions

Every version is worked out from what changed, one of two ways:

- **Declared:** the package's own `package.json` holds the version. Its next release raises the
  last one by the titles of the commits that touched the package's directory since: a `feat` makes
  it a minor, and anything else a patch. A release writes the new version into the manifest.
- **Derived:** the build writes the major and minor, at patch `0`, and a release sets the patch.
  For a gateway's package, that is the client's major and the gateway's latest schema number, as
  [the client package](/flex-platform/codegen/overview/#the-client-package) describes. Under the
  same major and minor, any other change is the next patch: a change to codegen's output, to the
  shared types it bundles, or to its peer range when the client has a new release.

A major is never worked out. A change that breaks a caller is a person's decision: they set the
new version in the package's `package.json` in the same pull request, and the release takes it.
A gateway's package follows the client to its new major.

Below `1.0.0` the same rules hold: a new minor adds and a patch fixes, and neither breaks a
caller, so every gateway package admits any later client of its major.

## The record

`packages/release/releases.json` holds each package's last released version and a digest of
what was released under it, one package to a line. The digest is taken over every file the build
writes, with the manifest the package is published under, less its own version, so it says whether
a package has changes no release holds yet. It is not taken over a tarball, because gzip output can
differ between zlib builds, and a laptop and a runner must agree.

Only a release changes the record. A recorded version only moves forward, and its digest never
changes while its version stays the same, since a published version can never be published again.
The Release check on each pull request refuses a change that breaks either rule.

## Candidates

Only gateway packages have candidates, because only their finals wait: for production to serve the
gateway's schema. A candidate stands in for the final until then. The client is only ever published
as a final, since nothing it does depends on a deployment.

A candidate is the version its release recorded, with `-rc.<n>`, where `<n>` is the number of
commits `main` has when it is published. It names the client its build names, which is the
client's recorded version. When the same release raises the client, that is the client's new
final, which is published first.

Candidates go under the `rc` tag, never `latest`, so installing a package without a version never
gives a candidate. A domain trying one names its exact version.

## Preparing a release

From the workspace root, on a branch with nothing uncommitted:

```bash
pnpm release          # choose what is released, at a prompt
pnpm release --all    # release everything with unreleased changes
```

The command builds every package and lists them all, grouped as in the table above, each with the
version its release would take and why. Only a package with changes no release holds yet can be
chosen, and choosing a group's name chooses every such package in it. Choosing a package ticks
what the release then needs too, with the reason beside it, and those stay ticked until nothing
chosen needs them:

- every package that depends on one released, since it names the new version once built again.
  Choosing the client ticks every gateway package and every SDK that depends on it;
- every package with unreleased changes that one released depends on, since those changes were
  built into it.

It then writes the record, and each declared package's new version into its manifest, and prints
a table for the pull request's description. If it stops part of the way, it puts back any manifest
it changed.

## Checking a release

Each pull request to `main` runs the Release check, in `.github/workflows/ci-pr-release.yml`, on
the commit its merge would make:

```bash
pnpm exec release verify --base <commit>
```

`verify` compares the record with the base's. If the pull request changes it, each package whose
entry changed must build as its entry records it: the same digest, at a version its build can be
released as. A release prepared against an older `main` must be prepared again. Since the check
runs on the merge, a release that passes it builds on `main` as it records.

## Publishing

The pipeline runs two commands on `main`. Nobody runs them by hand:

```bash
pnpm exec release pack --out <dir>
pnpm exec release publish <dir> --stage merge   # then, at production, --stage production
```

`pack` builds every package and asks the registry what it holds of each recorded package. It packs
each recorded version the registry does not have, in two stages, by when each is published:

- **`merge`:** the client's final, under `latest`, and a candidate of each gateway package, under
  `rc`, unless one of its recorded version is already published.
- **`production`:** each gateway package's final, under `latest`. The final is the same build as
  its candidate, under its own version, so what is published is what was tested.

`pack` holds back two kinds of recorded version, and lists each with the reason:

- one `main` no longer builds as recorded. The Release check means only later changes can do that,
  so a later release replaces it, and that version is never published;
- one whose build names a client version that is not published, and is not published first in the
  same stage. That is the client passed over as above, or one whose version is set ahead of its
  release.

`pack` needs the whole history to count commits, and refuses a shallow clone. Reading the registry
needs a token that can read packages.

`publish` publishes one stage from that directory, each package after the ones it depends on. A
version already published is passed over, so a stage that failed part of the way through can run
again. Publishing reads the registry from `.npmrc`, and needs a token that can write packages.

The Publish job in `.github/workflows/main.yml` runs both for each push to `main`, once the quality
checks pass, with the workflow's own token, and publishes the `merge` stage. Only one runs at a
time, and the others wait their turn, oldest first. Only the run for `main`'s newest commit
publishes: a run whose commit `main` has moved past publishes nothing. Since each run publishes
whatever the registry is missing, the run for the newest commit publishes what the runs before it
passed over. Publishing only moves forward, so an older release is never published after a newer
one.

Publishing the `production` stage is planned. It will run once the gateways a release carries reach
production, so a gateway's new minor is never published before production serves its schema. A
release whose gateways never reach production publishes no final for them: its candidates are all it
leaves, and a later release takes the next version, so a gateway package's finals can skip a
version. The stage will publish a final only while its version is still the one the record on
`main` holds, and skip it otherwise. Until then, a gateway package's final is packed on each run,
but not published.
