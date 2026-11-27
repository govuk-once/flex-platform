---
title: Releasing packages
description: How the published packages are versioned, how candidates and releases are published, and how a release is prepared.
---

The packages that domains install are published to GitHub Packages, in the `@govuk-once/` scope.
Nothing is published unless a release records it. A release is a pull request. `pnpm release`
prepares it, a person reviews it, and once it is merged the pipeline publishes it:

- **The client:** its final, as the release merges.
- **Each gateway's package:** a release candidate as the release merges, so it can be tried. Then
  its final, once production serves the gateway's schema. Publishing that final is
  [planned](#publishing), so until then a gateway's package has candidates only.

Nothing is published from a laptop. `@repo/release`, in `packages/release`, does all of it. Its
`src/sources.ts` lists what is published:

| Package | Built by | Versioned | Final published |
|---|---|---|---|
| `@govuk-once/flex-gateway-client` | its `build` script, into `dist/` | declared | as the release merges |
| Each gateway's [client package](/flex-platform/codegen/overview/#the-client-package) | `codegen`, into `.gen/client/package/` | derived | at production (planned) |

A gateway's package is listed because it is in `gateways/services/`. Nothing needs to be added.

## Versions

Every version is worked out from what changed, in one of two ways:

- **Declared:** the package's own `package.json` holds the version. Its next release raises the
  last version by a patch, a minor or a major. A person chooses which as they prepare the release,
  and the release writes the new version into the manifest.
- **Derived:** the build writes the major and minor, at patch `0`, and a release sets the patch.
  For a gateway's package, the major is the client's major and the minor is the gateway's latest
  schema number, as [the client package](/flex-platform/codegen/overview/#the-client-package)
  describes. Under the same major and minor, any other change is the next patch. That covers a
  change to codegen's output, to the shared types it bundles, or to its peer range when the client
  has a new release.

A version can also be set by hand in the package's `package.json`, ahead of its last release. The
release then takes it without asking. A gateway's package follows the client to a new major.

The same rules hold below `1.0.0`. A new minor adds and a patch fixes, and neither breaks a caller.
So every gateway package accepts any later client of its major.

## The record

`packages/release/releases.json` holds one line per package. Each line holds the package's last
released version and a digest of what was released under it.

The digest covers every file the build writes, and the manifest the package is published under,
less its own version. So the digest shows whether a package has changes that no release holds yet.
It is not taken over a tarball, because gzip output can differ between zlib builds, and a laptop
and a runner must agree.

Only a release changes the record. Two rules hold:

- A recorded version only moves forward.
- A digest never changes while its version stays the same, because a published version can never
  be published again.

The Release check on each pull request refuses a change that breaks either rule.

## Candidates

Only gateway packages have candidates, because only their finals wait: for production to serve the
gateway's schema. A candidate stands in for the final until then. The client is only ever
published as a final, because nothing it does depends on a deployment.

A candidate's version is the version its release recorded, followed by `-rc.<n>`. `<n>` is the
number of commits `main` has when the candidate is published. The candidate names the client
version its build names, which is the client's recorded version. If the same release raises the
client, that version is the client's new final, and it is published first.

Candidates go under the `rc` tag, never `latest`, so installing a package without a version never
gives a candidate. A domain that tries one names its exact version.

## Preparing a release

Run the command from the workspace root, on a branch with nothing uncommitted:

```bash
pnpm release          # choose what is released, at a prompt
pnpm release --all    # release everything with unreleased changes
```

The command builds every package and lists them all, grouped as in the table above. Each package
shows the version its release would take, and why. Only a package with changes that no release
holds yet can be chosen. Choosing a group's name chooses every such package in it.

Choosing a package also ticks what the release then needs, in yellow rather than green, with the
reason beside it:

- every package that depends on a released package, because once built again it names the new
  version. Choosing the client ticks every gateway package.
- every package with unreleased changes that a released package depends on, because those changes
  were built into it.

Those stay ticked until nothing chosen needs them. Clearing one does nothing until then.

Next, the command asks how to raise each declared package it releases, unless the package's
manifest already sets a version ahead of the last release. `--all` asks nothing, and raises each
by a patch.

Finally, the command writes the record and each declared package's new version into its manifest.
It prints a table for the pull request's description. If it stops part of the way through, it puts
back any manifest it changed.

## Checking a release

Each pull request to `main` runs the Release check, in `.github/workflows/ci-pr-release.yml`. The
check runs on the commit that the pull request's merge would make:

```bash
pnpm exec release verify --base <commit>
```

`verify` compares the record with the base's. If the pull request changes the record, each package
whose entry changed must build as its entry records it. That means the same digest, at a version
its build can be released as. A release prepared against an older `main` must be prepared again.
Because the check runs on the merge, a release that passes it builds on `main` as it records.

## Publishing

The pipeline runs two commands on `main`. Nobody runs them by hand:

```bash
pnpm exec release pack --out <dir>
pnpm exec release publish <dir> --stage merge   # then, at production, --stage production
```

`pack` builds every package and asks the registry which versions it holds of each recorded
package. It packs each recorded version that the registry does not have. It packs them in two
stages, by when each is published:

- **`merge`:** the client's final, under `latest`, and a candidate of each gateway package, under
  `rc`. It skips a gateway package if a candidate of its recorded version is already published.
- **`production`:** each gateway package's final, under `latest`. The final is the same build as
  its candidate, under its own version, so what is published is what was tested.

`pack` holds back two kinds of recorded version, and lists each with the reason:

- A version that `main` no longer builds as recorded. Because of the Release check, only later
  changes can cause this. A later release replaces it, and that version is never published.
- A version whose build names a client version that is not published, and is not published first
  in the same stage. That client version is either one passed over as above, or one set ahead of
  its release.

`pack` needs the whole history to count commits, so it refuses a shallow clone. Reading the
registry needs a token that can read packages.

`publish` publishes one stage from that directory, each package after the ones it depends on. It
passes over a version that is already published, so a stage that failed part of the way through
can run again. It reads the registry from `.npmrc`, and needs a token that can write packages.

The Publish job in `.github/workflows/main.yml` runs both commands for each push to `main`, once
the quality checks pass. It uses the workflow's own token, and publishes the `merge` stage.

- Only one run happens at a time. The others wait their turn, oldest first.
- Only the run for `main`'s newest commit publishes. A run whose commit `main` has moved past
  publishes nothing.
- Each run publishes whatever the registry is missing. So the run for the newest commit publishes
  what the runs before it passed over.

Publishing only moves forward, so an older release is never published after a newer one.

Publishing the `production` stage is planned. It will run once the gateways a release carries reach
production, so a gateway's new minor is never published before production serves its schema.

- If a release's gateways never reach production, the release publishes no final for them. Its
  candidates are all it leaves. A later release takes the next version, so a gateway package's
  finals can skip a version.
- The stage will publish a final only while its version is still the one the record on `main`
  holds. Otherwise it will skip it.

Until then, each run packs a gateway package's final but does not publish it.
