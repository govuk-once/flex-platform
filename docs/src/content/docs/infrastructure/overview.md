---
title: Infrastructure
description: The CDK app that deploys the platform, its stages and config, and the rules for adding to it.
---

The platform deploys with AWS CDK, from one app in `infra/app`. It defines no stacks yet. This page
describes the app and the rules every stack added to it follows.

## Stages and environments

The platform itself moves through three **stages**: platform-dev, platform-staging and
platform-prod. Each stage has its own shared account, and one or more **environments**, each with a
frontdoor account and a list of named domain accounts (one, for now). The dev, staging and prod environments that domain teams
use all run inside platform-prod.

A deploy targets one stage, so the app builds only the one it's asked for, with that stage's
stacks directly in the app. Each stage deploys to its own accounts, so stack names carry no stage,
and one stage's templates compare directly with another's.

```bash
pnpm --filter @repo/infra-app synth -c stage=platform-dev
pnpm --filter @repo/infra-app diff -c stage=platform-dev
```

Without `-c stage`, or with a name the config doesn't have, synth stops and lists the known stages.

## Config

`infra/app/src/config/stages.ts` holds every stage's values, typed as `StageConfig`, and is
committed to this repository. Every field is required, so every difference between stages is
written out side by side. A value is in config whenever it can be known before deploy. A secret
never is: config names a secret, never holds one.

Before building any stage, the app checks every stage's config:

- stage, environment and domain account names are 1 to 32 lowercase letters, digits and hyphens,
  starting with a letter and not ending with a hyphen, and each is unique where it's used. That's
  a DNS label, narrowed: names become DNS labels and parts of resource names, a CloudFormation
  stack name must start with a letter, and 32 keeps names built from several of them within AWS
  limits such as 64 characters for an IAM role;
- every account ID is 12 digits, and each account is used in exactly one place in exactly one
  stage. A stage only trusts its own accounts, so an account shared between stages would let a
  change to one reach the other.

## Rules for stacks and constructs

- **Only config differs.** A construct receives values, never a stage or environment name to
  branch on. Stages differ only in their config, and in how long their lists are.
- **Construct IDs are a contract.** A resource's logical ID comes from its construct path, so
  moving or renaming a scope replaces the resource. In a loop, build IDs from config keys, never
  positions in a list.
- **Every stack has an explicit `env`,** and synth never looks anything up in an account
  (`fromLookup`). Synth stays offline and gives the same result every time.
- **Wire stacks together by names derived from config, and declare each dependency.** A stack that
  uses another stack's resource builds its name or ARN from config, with the same function the
  producer names it with, and declares `stack.addDependency(producer)` where it needs the
  resource to exist at deploy. Never a cross-stack reference: the consumer's template would hold
  a lookup instead of the value, so replacing the producer's resource would change no consumer.
  A shared resource that has to be replaced gets a new name, so the change reaches every
  consumer's template.

## Checks

The app runs cdk-nag's AWS Solutions rules as a validation plugin, so any finding fails synth, and
with it the tests. To accept a finding, acknowledge it on the construct where it arises with CDK's
own API, and give the reason:

```ts
Validations.of(construct).acknowledge({ id: "AwsSolutions-S1", reason: "..." });
```

A finding that holds for a whole stack is acknowledged on the stack, once.

Tags go on stacks. CloudFormation propagates a stack's tags to the resources in it that support
stack-tag propagation, which is not every resource that can be tagged. Every stack carries the
platform's tags, defined once in `infra/app/src/tags.ts`:
`Product`, `System`, `Owner`, `ResourceOwner` and `Source`, plus `Stage` and the prune marker,
`flex:managed-by: flex-platform`. A stack that sets one of these keys itself keeps its own value, so a
domain's stack can name its own `Owner`. The prune step finds the stacks this app owns by the
marker, so it stays the same through any change to the tag set.

No tag changes on every deploy, such as a commit or a version. A stack tag propagates to the
stack's resources, so it would update all of those each time.

Tag keys follow two styles:

| Kind | Key | Example | Read by |
|---|---|---|---|
| Organisation and reporting | GDS UpperCamelCase | `Product`, `Owner`, `Source` | People and cost reports |
| Platform | `flex:` and lowercase kebab-case | `flex:managed-by` | The platform's own tooling, such as pruning |

The `flex:` prefix keeps the platform's keys apart from keys other teams and tools set, such as a
plain `ManagedBy`. Values are lowercase identifiers that stay the same from one deploy to the
next.

CDK's feature flags are written out in `infra/app/cdk.json`, as `cdk init` generated them for
`aws-cdk-lib` 2.270.0, and the tests build every app with them, so they test what deploys. Upgrading CDK doesn't change them. Turning on a new flag can replace
resources, so each one is a deliberate change of its own. The CDK CLI's telemetry is off.
