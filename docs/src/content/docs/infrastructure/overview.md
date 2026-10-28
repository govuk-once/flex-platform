---
title: Infrastructure
description: The CDK app that deploys the platform, its stages and config, and the rules for adding to it.
---

The platform deploys with AWS CDK, from one app in `infra/app`. So far it builds the
[Frontdoor](/flex-platform/frontdoor/overview/)'s stacks and each domain account's
[network](/flex-platform/infrastructure/network/). This page describes the app and the rules every
stack added to it follows.

Infrastructure lives with the section it belongs to. A section's constructs are in its own
`infra/` package, such as `frontdoor/infra`. Constructs and checks more than one section uses are in
`infra/constructs`, the network's among them, since domains and gateways both run in it. The app,
its config and its stacks are in `infra/app`.

Imports run one way, so there are no cycles: `infra/constructs`, then a section's `infra/`, then
`infra/app`. A section's `infra/` package imports `@repo/infra-constructs`, `@repo/utils` and its
own section's `@repo/<section>-` packages, and nothing else from the workspace: no other section,
and never the app. `infra/constructs` imports only `@repo/utils`. Lint enforces both, through the
`infraConstructs` and `sectionInfra` presets. `infra/app` is the only place sections meet: when
one section's construct needs another's name, such as the role a domain's API lets in, it takes
the name as a prop, and `infra/app` builds it with the owning section's name function. Each
section decides how it builds its own names, following the template below.

## Stages and environments

The platform itself moves through three **stages**: platform-dev, platform-staging and
platform-prod. Each stage has its own shared account, and one or more **environments**. Each
environment has a frontdoor account and a list of named domain accounts (one, for now). The
development, staging and production environments that domain teams use all run inside
platform-prod. platform-dev and platform-staging have one environment each, `development` and
`staging`.

A deploy targets one stage, so the app builds only the one it's asked for, with that stage's
stacks directly in the app. Each stage deploys to its own accounts, so stack names carry no stage,
and one stage's templates compare directly with another's.

```bash
pnpm --filter @repo/infra-app synth -c stage=platform-dev
pnpm --filter @repo/infra-app diff -c stage=platform-dev
```

Without `-c stage`, or with a name the config doesn't have, synth stops and lists the known stages.
`-c target=<environment>` builds only that environment's stacks, and `-c target=shared` only the
shared account's. A target selects what to build, never how it's built.

## Stacks

Each environment has these stacks:

| Stack | Account | Region | One per | Holds |
|---|---|---|---|---|
| `frontdoor-<environment>-edge-logs-eu-west-2` | Frontdoor | eu-west-2 | Environment | Lambda@Edge's log group, and the policy that lets its role write to it |
| `frontdoor-<environment>` | Frontdoor | us-east-1 | Environment | The certificate and DNS records, the distribution, the web ACL, the CloudFront Function, the Lambda@Edge function and its role, and their other log groups |
| `network-<environment>-<account>` | Domain | eu-west-2 | Domain account | The VPC, its subnets, NAT gateways, interface endpoints, security groups, network ACLs, and its flow logs: see [Network](/flex-platform/infrastructure/network/) |

The Frontdoor's stacks are in us-east-1 because CloudFront takes its web ACL, its certificate and
its Lambda@Edge functions from there. Lambda@Edge's log group is in a stack of its own, in the one
region its logs are kept: see [the Frontdoor's logs](/flex-platform/frontdoor/overview/#logs). The
region is in the stack's name, so keeping logs in another region later is another stack beside it.
`frontdoor-<environment>` depends on it, so it deploys first.

A network's stack depends on no other, and nothing depends on it yet.

Every stack has termination protection. Deleting `frontdoor-<environment>` would take the app's
entry point and its domain name with it, deleting the log stack would leave Lambda@Edge's logs
nowhere to go, and deleting a network would take every workload's network with it, and the NAT
addresses upstreams allowlist. So deleting any of them takes a deliberate step first: turning the
protection off.

Each account is bootstrapped for CDK in each region it deploys to, so a frontdoor account is
bootstrapped in us-east-1 and eu-west-2, and a domain account in eu-west-2.

## Config

`infra/app/src/config/stages.ts` holds every stage's values, typed as `StageConfig`, and is
committed to this repository. Every field is required, so every difference between stages is
written out side by side. A value is in config whenever it can be known before deploy. A secret
never is: config names a secret, never holds one.

```ts
StageConfig       { name, shared: { account }, environments }
EnvironmentConfig { name, frontdoor: { account, zone, issuers }, domainAccounts }
DomainAccount     { name, account, domains, zone, network: { availabilityZones } }
```

- `domains` lists the names of the domains a domain account hosts in the environment. See
  [Hosting a domain](/flex-platform/domains/hosting/).
- `zone` is the account's public hosted zone, as `{ name, id }`. The zones aren't the platform's:
  another team creates one in each account, already delegated, named
  `<environment>.flex-<account role>.once.service.gov.uk`. An account writes records only into
  its own zone. The Frontdoor answers at its zone's apex, and each domain will answer at
  `<domain>.<its domain account's zone>`.
- `network.availabilityZones` lists the zones the account's network uses, in any order. Each has
  its own NAT gateway. See [availability zones](/flex-platform/infrastructure/network/#availability-zones).
- `issuers` lists the Cognito user pools whose access tokens the Frontdoor accepts, each as its
  issuer URL, `https://cognito-idp.<region>.amazonaws.com/<pool ID>`, and the app client IDs it
  accepts from that pool.

Before building any stage, the app checks every stage's config:

- stage, environment and domain account names are 1 to 32 lowercase letters, digits and hyphens,
  starting with a letter and not ending with a hyphen, and each is unique where it's used. That's
  a DNS label, narrowed: names become DNS labels and parts of resource names, a CloudFormation
  stack name must start with a letter, and 32 keeps names built from several of them within AWS
  limits such as 64 characters for an IAM role;
- every account ID is 12 digits, and each account is used in exactly one place in exactly one
  stage. A stage only trusts its own accounts, so an account shared between stages would let a
  change to one reach the other;
- every zone's name is a DNS name of lowercase labels with at least one dot and no trailing dot,
  and its ID is a hosted zone ID without `/hostedzone/`. A certificate's name may be at most 64
  characters, ACM's limit, so the Frontdoor's zone name, and `*.` and each domain account's zone
  name, must fit within it;
- every environment trusts at least one issuer, each an `https` URL naming at least one app
  client;
- every domain's name follows the same rule as the names above and is used once in its
  environment, across all its domain accounts, and its function's name is within Lambda's 64
  characters. See [checks](/flex-platform/domains/hosting/#checks);
- every domain account's network lists at least two availability zones, each once, and each one
  the network has a layout for.

## Rules for stacks and constructs

- **Only config differs.** A construct receives values, never a stage or environment name to
  branch on. Stages differ only in their config, and in how long their lists are.
- **Values are constants by default.** A value that is the same everywhere, such as a WAF limit
  or a timeout, is a constant beside the code that uses it. Config holds only what a stage needs
  to differ, in `infra/app` only. An optional feature is a toggle in config, never a check of the
  environment's name.
- **Names follow one template.** A name the platform gives a resource or a stack is
  `{section}-{environment}-{thing}`, such as `frontdoor-production-origin-request`, with
  `-{region}` last for one of a set kept once per region. An environment's main stack is
  `{section}-{environment}` alone. A log group is a path, `/flex/{section}/{environment}/{thing}`.
  Where AWS requires a prefix, such as WAF's `aws-waf-logs-`, the name follows it. Each section
  builds its names with functions in one module, such as `frontdoor/infra/src/names.ts`, which
  states the template too.
- **Construct IDs are a contract.** A resource's logical ID comes from its construct path, so
  moving or renaming a scope replaces the resource. In a loop, build IDs from config keys, never
  positions in a list.
- **Every stack has an explicit `env`,** and synth never looks anything up in an account
  (`fromLookup`). Synth stays offline and gives the same result every time. A resource the
  platform doesn't own, such as a hosted zone, is named from config. A stack with an explicit
  `env` looks its availability zones up when something asks for them, as CDK's `Vpc` does, so a
  stack with a VPC names its zones by overriding `availabilityZones`.
- **Wire stacks together by names derived from config, and declare each dependency.** A stack that
  uses another stack's resource builds its name or ARN from config, with the same function the
  producer names it with, and declares `stack.addStackDependency(producer, reason)` where it needs
  the resource to exist at deploy, across accounts and regions too. Never a cross-stack
  reference: the consumer's template would hold a lookup instead of the value, so replacing the
  producer's resource would change no consumer. A shared resource that has to be replaced gets a
  new name, so the change reaches every consumer's template.

## Checks

The app runs cdk-nag's AWS Solutions rules as a validation plugin, so any finding fails synth, and
with it the tests. To accept a finding, acknowledge it on the construct where it arises with CDK's
own API, and give the reason:

```ts
Validations.of(construct).acknowledge({ id: "AwsSolutions-S1", reason: "..." });
```

A finding that holds for a whole stack is acknowledged on the stack, once.

The platform's own rules are plugins beside it, from `infra/constructs`, one per rule. Each fails
synth on any resource of its type, in any template, that doesn't meet its rule, including one a
construct creates for itself, and each rule has a construct that meets it:

| Check | Rule | Construct | A resource must |
|---|---|---|---|
| `LogGroupCheck` | `Flex-LogGroup` | `PlatformLogGroup` | Keep its logs for a year, be encrypted with a KMS key, be protected from deletion, and be retained when its stack is deleted |
| `BucketHttpsCheck` | `Flex-BucketHttps` | `PlatformBucket` | Have a policy that denies, to anyone, every request to the bucket and its objects over plain HTTP, and over TLS older than 1.2, each in a statement with no other condition |

A new rule is a `ResourceCheck`: the type it applies to, and the locations at fault in a resource
of that type.

`PlatformLogGroup` encrypts every log group in a stack with that stack's own key, `LogGroupKey`,
which rotates yearly, is retained as the log groups are, and lets CloudWatch Logs use it only for
log groups in its own account and region. The check can't see a log group an AWS service creates
when it first writes, so a log group a service would create is created ahead of it, by name.
`PlatformBucket` also blocks public access and encrypts with S3's own keys, which cdk-nag checks,
and keeps every version of an object, so an overwrite or a delete can be undone. Given `lockedFor`,
it locks each version for that long with S3 Object Lock in compliance mode, which nobody, the
account's root user included, can delete or shorten. A locked bucket is always retained.

A check rejects; it never fixes. So a resource built without its construct fails synth where it's
defined, rather than being changed out of sight. For a resource inside a construct that isn't ours,
meet the rule on that resource, or acknowledge the finding with a reason.

`buildApp` lists every check, cdk-nag's and the platform's, and adds the one aspect, `StackTags`,
which tags every stack. Anything else that applies to the whole app goes there too. Prefer a construct and a check to an
aspect: an aspect is for what no construct can reach.

### Tags

Tags go on stacks, every stack in the app, whoever creates it. CloudFormation propagates a stack's
tags to the resources in it that support stack-tag propagation, which is not every resource that
can be tagged. Every stack carries the platform's tags, defined once in
`infra/app/src/tags.ts`:
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

### Feature flags

CDK's feature flags are written out in `infra/app/cdk.json`, as `cdk init` generated them for
`aws-cdk-lib` 2.270.0. Upgrading CDK doesn't change them. Turning on a new flag can replace
resources, so each one is a deliberate change of its own. The CDK CLI's telemetry is off.

## Tests

Every CDK test builds its app with `cdkApp()` from `@repo/infra-constructs`, as the
deployed app does. It applies the flags from `cdk.json`, so a test checks what deploys, not CDK's
defaults. `cdkApp` reads that file by path, so `turbo.json` names it as a global dependency: a flag
change reruns every task, rather than leaving a cached result that used the old flags.

`infra/app` builds its fixture stages, in `test/helpers.ts`, and the committed stages, and checks
that:

- each kind of stack, the Frontdoor's and the networks, has the same resources in every
  environment of every stage once names, accounts and availability zones are set aside, so nothing
  in a stack depends on which environment it is. This runs on both sets of stages;
- synthesizing any stage asks for no lookup in an account;
- reversing every list in the fixtures' config, availability zones included, changes no logical
  ID;
- each committed stage's inventory matches its snapshot, in
  `src/__snapshots__/inventory.<stage>.json`: every stack's name, account, region and
  dependencies, and every resource's logical ID and type. A changed logical ID replaces the
  resource, so it shows in review, and so does what a config change does to the real stacks.
  Lambda versions are left out, since their IDs change with their code.

After a deliberate change, update the snapshots with
`pnpm --filter @repo/infra-app exec vitest run src/inventory.test.ts -u`, and review the diff.
