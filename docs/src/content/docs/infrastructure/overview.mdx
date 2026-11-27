---
title: Infrastructure
description: The CDK app that deploys the platform, its stages and config, and the rules for adding to it.
---

The platform deploys with AWS CDK, from one app in `infra/app`. The app builds:

- the [Frontdoor](/flex-platform/frontdoor/overview/)'s stacks;
- each domain account's [network](/flex-platform/infrastructure/network/);
- the stacks that [host the domains](/flex-platform/domains/hosting/);
- each stage's [test users](#test-users).

This page describes the accounts, the stages and the stacks, and the rules every stack added to
the app follows. [Config](/flex-platform/infrastructure/config/) holds every stage's values, and
[Deploying](/flex-platform/infrastructure/deploying/) covers how a stage reaches its accounts.

Infrastructure lives with the section it belongs to:

- A section's constructs are in its own `infra/` package, such as `frontdoor/infra`.
- The shared account's constructs are in `shared/infra`.
- Constructs and checks that more than one section uses are in `infra/constructs`. The network's
  constructs are there, because domains and gateways both run in it. So are the parts of a
  CloudFront distribution that aren't particular to the Frontdoor:
  - the web ACL;
  - a CloudFront Function, with its log group;
  - the response headers;
  - the access logs;
  - the certificate and records at a zone's apex.
- The app, its config and its stacks are in `infra/app`.

Imports run one way, so there are no cycles: `infra/constructs`, then a section's `infra/`, then
`infra/app`. A section's `infra/` package imports `@repo/infra-constructs`, `@repo/utils` and its
own section's `@repo/<section>-` packages. It imports nothing else from the workspace: no other
section, and never the app. `infra/constructs` imports only `@repo/utils`. Lint enforces both
rules, through the `infraConstructs` and `sectionInfra` presets.

`infra/app` is the only place where sections meet. Sometimes one section's construct needs a name
that another section owns, such as the role a domain's API lets in. The construct then takes the
name as a prop, and `infra/app` builds it with the owning section's name function. Each section
decides how it builds its own names, following the
[template below](#rules-for-stacks-and-constructs).

## Stages and environments

The platform itself moves through three **stages**: platform-dev, platform-staging and
platform-prod. Each stage has its own shared account, and one or more **environments**. Each
environment has a frontdoor account and a list of named domain accounts (one, for now).

The development, staging and production environments that domain teams use all run inside
platform-prod. platform-dev and platform-staging have one environment each, `development` and
`staging`.

## Accounts

Each stage has its own accounts, 13 in all:

| Account | One per | Holds |
|---|---|---|
| Shared | Stage | What spans the stage's environments: the [test user pool](#test-users), and the [pipeline API](/flex-platform/domains/release-pipeline/) with the bucket and tables a domain's release uses |
| Frontdoor | Environment | The [Frontdoor](/flex-platform/frontdoor/overview/), and the [caller token's](/flex-platform/frontdoor/caller-token/) keys and push ID secret |
| Domain | Environment, `domain00` for now | The environment's [domains](/flex-platform/domains/hosting/), the [gateways](/flex-platform/gateways/overview/) they call, and the [network](/flex-platform/infrastructure/network/) both run in |

platform-dev and platform-staging have three accounts each, and platform-prod has seven.

The accounts are split by what each must keep from the others:

- **The Frontdoor is apart from the code it routes to.** The frontdoor account holds what says who
  a request is for: the edge's role, the caller token's signing keys and the push ID's secret. No
  domain's code runs there, so none can reach them.
- **Domains and gateways share an account.** A domain invokes a gateway through the Lambda API,
  over the network's `lambda` endpoint, so a call never leaves the VPC. Both run in one network, and
  its DNS allowlist and NAT addresses are kept once per account.
- **What spans environments is in the shared account.** A domain's bundle is uploaded once, and
  each environment's release reads it in place from the shared account's bucket. One test user pool
  serves every environment of the stage that trusts it.
- **No account belongs to two stages.** A stage trusts only its own accounts, so a change to
  platform-dev can't reach platform-prod. [Config's checks](/flex-platform/infrastructure/config/)
  refuse an account used twice.
- **Every account is deployed by its own role.** Each account trusts only itself, and is deployed
  by a role of its own that only `main` may assume. No deploy reaches into another account. See
  [Deploying](/flex-platform/infrastructure/deploying/).

## Synthesizing a stage

A deploy targets one stage, so the app builds only the stage it is asked for, with that stage's
stacks directly in the app. Each stage deploys to its own accounts, so stack names carry no stage.
This means one stage's templates compare directly with another's.

```bash
pnpm --filter @repo/infra-app synth -c stage=platform-dev
pnpm --filter @repo/infra-app diff -c stage=platform-dev
```

Synth stops and lists the known stages if `-c stage` is missing, or names a stage the config
doesn't have. Two targets narrow what synth builds:

- `-c target=<environment>` builds only that environment's stacks.
- `-c target=shared` builds only the shared account's stacks, so no environment may be named
  `shared`.

A target selects what to build, never how it is built.

## Stacks

Each environment has these stacks:

| Stack | Account | Region | One per | Holds |
|---|---|---|---|---|
| `frontdoor-<environment>-edge-logs-eu-west-2` | Frontdoor | eu-west-2 | Environment | Lambda@Edge's log group, and the policy that lets its role write to it |
| `frontdoor-<environment>-caller-token-keys` | Frontdoor | eu-west-2 | Environment | The caller token's signing key, the push ID's secret, and key rotation and the tables it keeps the keys in, which the edge and every gateway read. See [the caller token](/flex-platform/frontdoor/caller-token/#stacks) |
| `frontdoor-<environment>` | Frontdoor | us-east-1 | Environment | The certificate and DNS records, the distribution, the web ACL, the CloudFront Function, the Lambda@Edge function and its role, and their other log groups |
| `network-<environment>-<account>` | Domain | eu-west-2 | Domain account | The VPC, its subnets, NAT gateways, interface endpoints, security groups, network ACLs, DNS Firewall, and its flow and query logs. See [Network](/flex-platform/infrastructure/network/) |
| `domainaccount-<environment>-<account>` | Domain | eu-west-2 | Domain account | What the account's domains share. See [what a domain account provides](/flex-platform/domains/hosting/#what-a-domain-account-provides) |
| `domain-<environment>-<domain>` | Domain | eu-west-2 | Domain | The domain's API and host, and its function's log group and roles. See [what a domain provides](/flex-platform/domains/hosting/#what-a-domain-provides) |
| `gateway-<environment>-<account>-<id>` | Domain | eu-west-2 | Gateway in a domain account | The gateway's function, its version and `live` alias, its role and log group, and its secret if it has its own. See [Environment](/flex-platform/reference/environment/#the-lambda-function) |

Each stage's shared account has three more:

| Stack | Account | Region | One per | Holds |
|---|---|---|---|---|
| `shared-identity` | Shared | eu-west-2 | Stage | The [test user pool](#test-users) and its client |
| `shared-release` | Shared | eu-west-2 | Stage | The pipeline API's function, built with [who may release each domain](/flex-platform/domains/release-pipeline/#what-the-api-checks), its URL, role and log group, the bucket [a domain's code is uploaded to](/flex-platform/domains/release-pipeline/#the-code-bucket), the [release worker](/flex-platform/domains/release-pipeline/#the-release-worker), its queues, role and log group, the [dead-letter worker](/flex-platform/domains/release-pipeline/#the-dead-letter-worker), its role, log group and [alarms](/flex-platform/domains/release-pipeline/#when-a-release-is-abandoned), the [table each version is recorded in](/flex-platform/domains/release-pipeline/#the-artefacts-table), the [table each release is recorded in](/flex-platform/domains/release-pipeline/#the-release-table), and the writer of the URL's host to us-east-1 |
| `shared-management` | Shared | us-east-1 | Stage | The certificate and DNS records, the distribution in front of [the pipeline API](/flex-platform/domains/release-pipeline/#the-pipeline-api), its web ACL and CloudFront Function, and their log groups |

A stage deploys only to its own accounts, so the shared account's stack names hold neither a stage
nor an environment.

`frontdoor-<environment>` is in us-east-1 because CloudFront takes its web ACL, its certificate and
its Lambda@Edge functions from there. The caller token's stack is in eu-west-2, where its keys are
made and kept, and where the gateways read them. See
[the caller token](/flex-platform/frontdoor/caller-token/#keys).

Lambda@Edge's log group is in a stack of its own, in the one region where its logs are kept. See
[the Frontdoor's logs](/flex-platform/frontdoor/overview/#logs). The region is in the stack's
name, so keeping logs in another region later means adding another stack beside it.
`frontdoor-<environment>` depends on the log stack, so the log stack deploys first.

`shared-management` is in us-east-1 for the same reason as `frontdoor-<environment>`. The pipeline
API's function is in eu-west-2, in `shared-release`, and AWS generates its URL's host there. So
`shared-release` [writes the host](#rules-for-stacks-and-constructs) to a parameter in us-east-1.
`shared-management` reads it, and depends on `shared-release` so that it deploys after it.

Each stack depends on the stacks whose resources it reads:

- A domain's stack depends on its account's stack. It reads that stack's certificate ARN, and its
  stage logs through that stack's API Gateway logging setting.
- A domain's stack also depends on its network's stack, whose subnet and security group IDs its
  deploy role reads.
- A domain's deploy role trusts `shared-release`'s worker by account and name, not by reference,
  so neither stack waits for the other.
- A gateway's stack depends on its network's stack, whose subnet, security group and endpoint IDs
  it reads.
- `frontdoor-<environment>` depends on every domain stack in its environment, across accounts and
  regions, so it never routes to a host before the host exists. It also depends on the caller
  token's stack, whose keys the edge signs with.

So an environment that hosts a domain deploys in this order:

1. The networks, the domain accounts' stacks and the caller token's stack.
2. The domains' and the gateways' stacks.
3. The Frontdoor's stack.

Every domain account has its own stack, whether or not it hosts a domain. So adding a domain
deploys only the domain's own stack and the Frontdoor's, whose routing map gains the domain.

Every stack has termination protection, because deleting any of them would do harm:

- Deleting `frontdoor-<environment>` would take the app's entry point and its domain name with it.
- Deleting the log stack would leave Lambda@Edge's logs nowhere to go.
- Deleting a network would take every workload's network with it, and the NAT addresses that
  upstreams allowlist.
- Deleting a domain account's stack would take the certificate every domain in it uses. It would
  also leave the account's API Gateway logging setting naming a deleted role.
- Deleting `shared-identity` would leave the test user pool, which is retained, out of the app's
  hands.
- Deleting `shared-management` would take the pipeline API's address with it.
- Deleting `shared-release` would take the function behind that address and the release worker.
  It would also leave the bucket of uploaded code out of the app's hands. The bucket is retained,
  and every released function reads its code from it.
- Deleting a gateway's stack would stop every domain's calls to its upstream.
- Deleting a domain's stack would take the role its function runs as, and the API and host it
  answers at.

So deleting any stack takes a deliberate step first: turning the protection off.

Nothing deletes a stack for the app. CDK doesn't delete a stack the app no longer builds. So a
gateway or a domain removed from config keeps its stack until someone turns its protection off and
deletes it. To withdraw a domain,
[disable it](/flex-platform/domains/hosting/#disabling-a-domain), which keeps its stack.

## Rules for stacks and constructs

- **Only config differs.** A construct receives values, never a stage or environment name to
  branch on. Stages differ only in their config, and in how long their lists are.
- **Values are constants by default.** A value that is the same everywhere, such as a WAF limit
  or a timeout, is a constant beside the code that uses it. Config holds only what a stage needs
  to differ, and only in `infra/app`. An optional feature is a toggle in config, never a check of
  the environment's name.
- **Names follow one template.** A name the platform gives a resource or a stack follows these
  forms:
  - A resource or stack is `{section}-{environment}-{thing}`, such as
    `frontdoor-production-origin-request`. If it is one of a set kept once per region, `-{region}`
    goes last.
  - An environment's main stack is `{section}-{environment}` alone.
  - A domain account's stack starts `domainaccount-`, not `domain-`. Names may hold hyphens, so
    only a different first word guarantees it never has the same name as a domain's stack.
  - A log group is a path, `/flex/{section}/{environment}/{thing}`.
  - A custom metric's namespace has the same form without the leading slash,
    `flex/{section}/{environment}/{thing}`, and its name is kebab-case.
  - If AWS requires a prefix, such as WAF's `aws-waf-logs-`, the name follows it.

  Each section builds its resources' names with functions in one module, such as
  `frontdoor/infra/src/names.ts`, which also states the template. Stack names are built in
  `infra/app`, beside each stack.
- **Construct IDs are a contract.** A resource's logical ID comes from its construct path, so
  moving or renaming a scope replaces the resource. In a loop, build IDs from config keys, never
  from positions in a list.
- **Every stack has an explicit `env`,** and synth never looks anything up in an account
  (`fromLookup`). Synth stays offline and gives the same result every time. A resource the
  platform doesn't own, such as a hosted zone, is named from config. A stack with an explicit
  `env` looks its availability zones up when something asks for them, as CDK's `Vpc` does. So a
  stack with a VPC names its zones by overriding `availabilityZones`.
- **Wire stacks together by names derived from config, and declare each dependency.** A stack that
  uses another stack's resource builds its name or ARN from config, with the same function the
  producer uses to name it. If it needs the resource to exist at deploy, it declares
  `stack.addStackDependency(producer, reason)`, across accounts and regions too. Never use a
  cross-stack reference. With one, the consumer's template would hold a lookup instead of the
  value, so replacing the producer's resource would change no consumer. A shared resource that has
  to be replaced gets a new name, so the change reaches every consumer's template.
- **A value AWS generates crosses regions through `CrossRegionParameters`.** See
  [values that cross regions](/flex-platform/infrastructure/building-blocks/#values-that-cross-regions).

## Test users

Every stage has a Cognito user pool of test users, `shared-test-users`, in its shared account. It
is for testing an environment from outside the platform, such as from a domain's tests or a
developer's machine. Software signs in as a test user. If the environment trusts the pool, the
Frontdoor lets the token through like any other. Every stage has the pool, so its stacks are the
same in each stage.

A test user's username is whatever its creator chose, and Lambda@Edge passes a token's username on
as the caller's pairwise ID. So an environment trusts test users only if its config names the pool
as `frontdoor.testUserIssuer`, which adds it to the Frontdoor's issuers. Validation refuses a test
user pool named in `issuers`. An environment that real users reach never sets `testUserIssuer`.

- **Only an administrator creates a user.** There is no sign-up, no hosted sign-in, no account
  recovery and no MFA.
- **Every password is generated,** and the pool refuses one shorter than 64 characters. The pool's
  client, also `shared-test-users`, allows `USER_PASSWORD_AUTH` and refresh, and no other flow. So
  a test user signs in only with Cognito's public `InitiateAuth`, which needs no AWS credentials.
  Anyone may try a password there, so its length is what protects it.
- **cdk-nag's MFA and Plus plan findings are acknowledged** on the pool. No person signs in as a
  test user. Threat protection guards passwords that people choose, and its adaptive checks would
  flag the same automation signing in again and again.

Cognito generates the pool's and the client's IDs. The CloudFront Function and Lambda@Edge have
their issuers built in when they are synthesized. So config can name the pool only once it exists.
The pool is retained and protected from deletion. The inventory snapshots hold its logical ID,
because a change to it is the one change that would make CloudFormation replace the pool.

Before a new stage's first full deploy:

1. Create the stage's pool first, with `-c target=shared`.
2. Write its IDs into `user-pools.ts`, so the environments that trust it can name it.

The stack outputs both IDs, as `TestUsersIssuer` and `TestUsersClientId`, and exports neither.
`shared-identity` depends on nothing and nothing depends on it, so it never holds up an
environment's deploy.
