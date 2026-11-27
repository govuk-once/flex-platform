---
title: Checks and tests
description: The checks that fail synth, the tags every stack carries, CDK's feature flags, and how the CDK tests are run.
---

## Checks

The app runs cdk-nag's AWS Solutions rules as a validation plugin, so any finding fails synth, and
with it the tests. To accept a finding, acknowledge it with CDK's own API, on the construct where
it arises, and give the reason:

```ts
Validations.of(construct).acknowledge({ id: "AwsSolutions-S1", reason: "..." });
```

Acknowledge a finding that holds for a whole stack on the stack, once.

The platform's own rules are plugins beside cdk-nag, from `infra/constructs`, one per rule. Each
fails synth on any resource of its type, in any template, that doesn't meet its rule. That
includes a resource a construct creates for itself. Each rule has a construct that meets it:

| Check | Rule | Construct | A resource must |
|---|---|---|---|
| `LogGroupCheck` | `Flex-LogGroup` | `PlatformLogGroup` | Keep its logs for a year, be encrypted with a KMS key, be protected from deletion, and be retained when its stack is deleted |
| `BucketHttpsCheck` | `Flex-BucketHttps` | `PlatformBucket` | Have a policy that denies, to anyone, every request to the bucket and its objects over plain HTTP, and over TLS older than 1.2, each in a statement with no other condition |
| `ApiIamCheck` | `Flex-ApiIam` | `ProxyApi`, in `@repo/domain-infra` | Be an API Gateway method with IAM authorisation, so API Gateway verifies each request's SigV4 signature and holds the signer to the API's resource policy, which for a domain admits the Frontdoor's edge role alone |
| `FunctionUrlIamCheck` | `Flex-FunctionUrlIam` | [`cloudFrontFunctionUrl`](/flex-platform/infrastructure/building-blocks/#a-function-behind-cloudfront) | Be a Lambda function URL with IAM authorisation, so Lambda verifies each request's SigV4 signature and runs the function only for a signer IAM allows |

A new rule is a `ResourceCheck`: the type it applies to, and the locations at fault in a resource
of that type.

`PlatformLogGroup` encrypts every log group in a stack with that stack's own key, `LogGroupKey`.
The key rotates yearly and is retained, as the log groups are. It lets CloudWatch Logs use it only
for log groups in its own account and region. The check can't see a log group that an AWS service
creates when it first writes. So the platform creates such a log group ahead of the service, by
name.

`PlatformBucket` also blocks public access and encrypts with S3's own keys, which cdk-nag checks.
It keeps every version of an object, so an overwrite or a delete can be undone. If given
`lockedFor`, it locks each version for that long with S3 Object Lock in compliance mode. Nobody,
the account's root user included, can delete a locked version or shorten its lock. A locked bucket
is always retained.

A check rejects and never fixes. So a resource built without its construct fails synth where it is
defined, rather than being changed out of sight. For a resource inside a construct that isn't
ours, meet the rule on that resource, or acknowledge the finding with a reason.

`buildApp` lists every check, cdk-nag's and the platform's. It also adds the one aspect,
`StackTags`, which tags every stack. Anything else that applies to the whole app goes there too.
Prefer a construct and a check to an aspect. An aspect is for what no construct can reach.

### Tags

Tags go on stacks: every stack in the app, whoever creates it. CloudFormation propagates a stack's
tags to the resources in it that support stack-tag propagation. That is not every resource that
can be tagged.

Every stack carries the platform's tags, defined once in `infra/app/src/tags.ts`:

- `Product`, `System`, `Owner`, `ResourceOwner` and `Source`;
- `Stage`;
- `flex:managed-by: flex-platform`, which marks a stack as one this app owns.

A stack that sets one of these keys itself keeps its own value, so a domain's stack can name its
own `Owner`. The mark is how to list the stacks the app has built in an account, including one
that has left config. So the mark stays the same through any change to the tag set.

No tag changes on every deploy, such as a commit or a version. A stack tag propagates to the
stack's resources, so such a tag would update all of them each time.

Tag keys follow two styles:

| Kind | Key | Example | Read by |
|---|---|---|---|
| Organisation and reporting | GDS UpperCamelCase | `Product`, `Owner`, `Source` | People and cost reports |
| Platform | `flex:` and lowercase kebab-case | `flex:managed-by` | The platform's own tooling |

The `flex:` prefix keeps the platform's keys apart from keys that other teams and tools set, such
as a plain `ManagedBy`. Values are lowercase identifiers that stay the same from one deploy to the
next.

### Feature flags

CDK's feature flags are written out in `infra/app/cdk.json`, as `cdk init` generated them for
`aws-cdk-lib` 2.270.0. Upgrading CDK doesn't change them. Turning on a new flag can replace
resources, so make each one a deliberate change of its own. The CDK CLI's telemetry is off.

## Tests

Every CDK test builds its app with `cdkApp()` from `@repo/infra-constructs`, as the deployed app
does. `cdkApp()` applies the flags from `cdk.json`, so a test checks what deploys, not CDK's
defaults. `cdkApp` reads that file by path, so `turbo.json` names it as a global dependency. A
flag change then reruns every task, rather than leaving a cached result that used the old flags.

The CDK packages (`infra/app`, `infra/constructs` and each section's `infra/`) run their test files
in shared workers, with `isolate: false` in each `vitest.config.ts`. Loading `aws-cdk-lib` takes
most of a small test file's time, and a shared worker loads it once instead of once per file. In
`infra/app`, a stage that `synthesizedStage` builds is shared the same way.

So a module and its state carry over from one test file to the next, in no fixed order. A CDK test
never mocks a module, sets an environment variable or changes anything global. It builds whatever
it changes itself, with its own `cdkApp()`.

`infra/app` builds its fixture stages, in `test/helpers.ts`, and the committed stages, and checks
that:

- each committed environment's config gives the same templates when built again under a name,
  accounts and zones that no environment has. Every property of every resource must match, once
  those values are set aside. So nothing in a stack depends on which environment it is: a construct
  that branches on an environment's name or an account fails here. Only the hashes of what holds
  the identity are set aside with them, such as Lambda@Edge's code, which holds the routes;
- synthesizing any stage asks for no lookup in an account;
- reversing every list in the fixtures' config, availability zones included, changes no logical
  ID;
- each committed stage's inventory matches its snapshot, in
  `src/__snapshots__/inventory.<stage>.json`. The inventory holds every stack's name, account,
  region and dependencies, and every resource's logical ID and type. A changed logical ID replaces
  the resource, so it shows in review, and so does what a config change does to the real stacks.
  Lambda versions are left out, since their IDs change with their code.

After a deliberate change, update the snapshots with
`pnpm --filter @repo/infra-app exec vitest run src/inventory.test.ts -u`, and review the diff.
