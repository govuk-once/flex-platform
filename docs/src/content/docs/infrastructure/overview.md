---
title: Infrastructure
description: The CDK app that deploys the platform, its stages and config, and the rules for adding to it.
---

The platform deploys with AWS CDK, from one app in `infra/app`. It builds the
[Frontdoor](/flex-platform/frontdoor/overview/)'s stacks, each domain account's
[network](/flex-platform/infrastructure/network/), the stacks that
[host the domains](/flex-platform/domains/hosting/), and each stage's [test users](#test-users).
This page describes the app and the rules every stack added to it follows.

Infrastructure lives with the section it belongs to. A section's constructs are in its own
`infra/` package, such as `frontdoor/infra`, and the shared account's are in `shared/infra`.
Constructs and checks more than one section uses are in
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
shared account's, so no environment may be named `shared`. A target selects what to build, never
how it's built.

## Stacks

Each environment has these stacks:

| Stack | Account | Region | One per | Holds |
|---|---|---|---|---|
| `frontdoor-<environment>-edge-logs-eu-west-2` | Frontdoor | eu-west-2 | Environment | Lambda@Edge's log group, and the policy that lets its role write to it |
| `frontdoor-<environment>-caller-token-keys` | Frontdoor | eu-west-2 | Environment | The caller token's signing key, the bucket every gateway reads its public keys from, and key rotation: see [the caller token](/flex-platform/frontdoor/caller-token/#stacks) |
| `frontdoor-<environment>` | Frontdoor | us-east-1 | Environment | The certificate and DNS records, the distribution, the web ACL, the CloudFront Function, the Lambda@Edge function and its role, and their other log groups |
| `network-<environment>-<account>` | Domain | eu-west-2 | Domain account | The VPC, its subnets, NAT gateways, interface endpoints, security groups, network ACLs, DNS Firewall, and its flow and query logs: see [Network](/flex-platform/infrastructure/network/) |
| `domainaccount-<environment>-<account>` | Domain | eu-west-2 | Domain account | What the account's domains share: see [what a domain account provides](/flex-platform/domains/hosting/#what-a-domain-account-provides) |
| `domain-<environment>-<domain>` | Domain | eu-west-2 | Domain | The domain's API and host, and its function's log group and roles: see [what a domain provides](/flex-platform/domains/hosting/#what-a-domain-provides) |
| `gateway-<environment>-<account>-<id>` | Domain | eu-west-2 | Gateway in a domain account | The gateway's function, its version and `live` alias, its role and log group, and its secret if it has its own: see [Environment](/flex-platform/reference/environment/#the-lambda-function) |

Each stage's shared account has one more:

| Stack | Account | Region | One per | Holds |
|---|---|---|---|---|
| `shared-identity` | Shared | eu-west-2 | Stage | The [test user pool](#test-users) and its client |

A stage deploys only to its own accounts, so the shared account's stack names hold neither a stage
nor an environment.

`frontdoor-<environment>` is in us-east-1 because CloudFront takes its web ACL, its certificate and
its Lambda@Edge functions from there. The caller token's stack is in eu-west-2, where its keys are
made and kept, and the gateways read them: see [the caller token](/flex-platform/frontdoor/caller-token/#keys). Lambda@Edge's log group is in a stack of its own, in the one
region its logs are kept: see [the Frontdoor's logs](/flex-platform/frontdoor/overview/#logs). The
region is in the stack's name, so keeping logs in another region later is another stack beside it.
`frontdoor-<environment>` depends on it, so it deploys first.

A domain's stack depends on its account's, whose certificate ARN it reads and whose API Gateway
logging setting its stage logs through, and on its network's, whose subnet and security group IDs
its deploy role reads. A gateway's stack depends on its network's, whose subnet, security group
and endpoint IDs it reads. `frontdoor-<environment>` depends on every domain stack in its environment,
across accounts and regions, so it never routes to a host before the host exists. It also depends on the caller token's stack,
whose keys the edge signs with. So an environment deploys in that order: the networks, the domain
accounts' stacks and the caller token's, then the domains' and the gateways' stacks, then the
Frontdoor's.

Every domain account has its stack, whether or not it hosts a domain, so adding a domain deploys
only the domain's own stack and the Frontdoor's, whose routing map gains it.

Every stack has termination protection. Deleting `frontdoor-<environment>` would take the app's
entry point and its domain name with it, deleting the log stack would leave Lambda@Edge's logs
nowhere to go, deleting a network would take every workload's network with it, and the NAT
addresses upstreams allowlist, and deleting a domain account's stack would take the certificate
every domain in it uses, and leave the account's API Gateway logging setting naming a deleted
role. Deleting `shared-identity` would leave the test user pool, which is retained, out of the
app's hands. Deleting a gateway's stack would stop every domain's calls to its upstream, and
deleting a domain's would take the role its function runs as, and the API and host it answers at.
So deleting any of them takes a deliberate step first: turning the protection off.

Nothing deletes a stack for the app. CDK doesn't delete a stack the app no longer builds, so a
gateway or a domain removed from config keeps its stack until someone turns its protection off
and deletes it. Withdrawing a domain is
[disabling it](/flex-platform/domains/hosting/#disabling-a-domain), which keeps its stack.

## Deploying

A merge to `main` deploys platform-dev, through GitHub Actions, once the quality checks pass. No
person deploys from their own machine. platform-staging and platform-prod have no deploy yet.

Each account is bootstrapped for CDK in each region it deploys to, so a frontdoor account is
bootstrapped in us-east-1 and eu-west-2, and a domain account and a shared account in eu-west-2.
Each trusts only itself. The platform team bootstraps the accounts, and gives each a role the deploy assumes through
GitHub's OIDC.

Each stage has a GitHub environment of the same name, which only `main` may deploy from. It holds
each account's role as a variable named `DEPLOY_ROLE_<account ID>`, such as
`DEPLOY_ROLE_553915472156`. A deploy that finds no variable for an account stops before it
deploys anything into it.

A deploy (`.github/workflows/_deploy.yml`) synthesizes the stage once, then deploys that cloud
assembly in waves. A stack is in the wave after the last stack it depends on, so the order comes
from the dependencies the app records, and `infra/app/bin/deploy-waves.ts` works it out. Each wave
runs a job per account, alongside each other, and each job deploys only its own account's stacks,
as that account's role, with `cdk deploy --exclusively`. Without `--exclusively`, `cdk deploy`
deploys a stack's dependencies too, including those in another account, which the role can't
reach. A wave starts once every job in the one before has succeeded.

For platform-dev, that is:

| Wave | Shared account | Domain account | Frontdoor account |
|---|---|---|---|
| 1 | `shared-identity` | `network-<environment>-<account>`, `domainaccount-<environment>-<account>` | `frontdoor-<environment>-edge-logs-eu-west-2`, `frontdoor-<environment>-caller-token-keys` |
| 2 | | `domain-<environment>-<domain>`, `gateway-<environment>-<account>-<id>` | |
| 3 | | | `frontdoor-<environment>` |

The workflow has three wave jobs. A stage whose stacks would need a fourth fails its plan before
anything deploys, and a test holds every stage in config to three. Adding a wave means a job in
the workflow and a change to `DEPLOY_WAVES`.

One deploy of a stage runs at a time, and the others wait, oldest first. A deploy never goes back:
each account's job first finds the commit the stage has, from the GitHub environment's latest
successful deployment, and fails unless its own commit includes it
(`infra/app/src/stage-check.ts`). A job can be run again on its own, reusing its run's plan, so
the check is in every job, not once per run. A commit can still go on to a stage after newer
commits have deployed elsewhere, so long as that stage has nothing newer.

Every account's job is a deployment of its own, so a commit counts as the stage's once any one of
its jobs succeeds, even if a later wave fails: some of the stage's stacks run it. So what the stage
has is the newest commit any of its stacks run, not the last commit that deployed in full. A failed
deploy is put right by deploying it again or a newer commit, never an older one.

## Config

`infra/app/src/config/stages.ts` holds every stage's values, typed as `StageConfig`, and is
committed to this repository. Every field is required, so every difference between stages is
written out side by side. A value is in config whenever it can be known before deploy. A secret
never is: config names a secret, never holds one.

```ts
StageConfig         { name, shared: { account, zone, testUsers },
                      domains: [{ name, repository: { name, id, ownerId } | null }], environments }
EnvironmentConfig   { name, release: "publish" | { promoteFrom },
                      frontdoor: { account, zone, issuers, testUsers }, domainAccounts }
DomainAccountConfig { name, account, domains: [name | { name, disabled: true }], zone,
                      network: { availabilityZones }, gateways }
GatewayConfig       { id, hostnames, placement, secret, target, roleArns }
```

- A domain account's `name` goes into its stacks' and resources' names. Every stage names its
  first `domain00`, which leaves room for more domain accounts in an environment.
- `domains` lists the domains a domain account hosts in the environment, each by its name, or
  as `{ name, disabled: true }` when it is disabled. See
  [Hosting a domain](/flex-platform/domains/hosting/).
- A stage's own `domains` lists every domain its environments host, once each, with the GitHub
  repository that may release it, or `null` until that repository exists. One entry serves every
  environment, because a domain's code is uploaded once and promoted. A repository's `id` and
  `ownerId` are GitHub's IDs for it and for its owner, in digits. A repository keeps them when it
  is renamed or transferred, and one created later under the same name has others. Its `name`,
  `<owner>/<repository>`, is for people to read.
- `release` says how a domain's code reaches the environment: `"publish"`, where new code enters
  the stage, or `{ promoteFrom }`, naming the environment whose released code it takes. Nothing
  reads `release` or a stage's `domains` yet: see
  [releasing a domain's function](/flex-platform/domains/hosting/#releasing-a-domains-function).
- `zone` is the account's public hosted zone, as `{ name, id }`. The zones aren't the platform's:
  another team creates one in each account, already delegated, named
  `<environment>.flex-<account role>.once.service.gov.uk`. An account writes records only into
  its own zone. The Frontdoor answers at its zone's apex, and each domain answers at
  `<domain>.<its domain account's zone>`. Nothing answers in a shared account's zone,
  `shared.zone`, yet.
- `network.availabilityZones` lists the zones the account's network uses, in any order. Each has
  its own NAT gateway. See [availability zones](/flex-platform/infrastructure/network/#availability-zones).
- `gateways` lists the gateways deployed in the account. Each domain account runs its own copy of
  a gateway its domains call. Each gateway has:
  - `id`, which names its function, `gateway-<environment>-<id>`, and its package,
    `@repo/gateway-service-<id>`, which `@repo/infra-app` depends on, so its tests wait on the
    gateway's codegen. Synth takes the bundle from `.gen/runtime/bundle.mjs` in that package.
  - `hostnames`, the names it connects to, which make up the network's DNS allowlist. See
    [the allowlist](/flex-platform/infrastructure/network/#the-allowlist).
  - `placement`, `isolated` or `private`. See [Egress](/flex-platform/start/platform/#egress).
  - `secret`, which becomes `FLEX_UPSTREAM_SECRET_ARN`: `"create"` for a secret the gateway's stack
    creates, or `{ arn, keyArn }` for one its upstream holds, with the KMS key it is encrypted with.
  - `target`, which becomes `FLEX_UPSTREAM_TARGET`, or `null` where the driver takes the target from
    the secret.
  - `roleArns`, the roles it assumes to sign as, such as an upstream's for `sigV4`.

  The secrets and roles feed the [endpoints' policies](/flex-platform/infrastructure/network/#endpoints)
  and the gateway's role exactly.
- `shared.testUsers` is the stage's [test user pool](#test-users), as an issuer URL and its app
  client ID, or `null` until the pool exists.
- `issuers` lists the Cognito user pools whose access tokens the Frontdoor accepts, each as its
  issuer URL, `https://cognito-idp.<region>.amazonaws.com/<pool ID>`, and the app client IDs it
  accepts from that pool. It never names a test user pool.
- `frontdoor.testUsers` is `true` where the Frontdoor also accepts the stage's test users.

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
  characters, ACM's limit, so the Frontdoor's zone name, the shared account's, and `*.` and each
  domain account's zone name, must fit within it;
- every issuer, in `issuers` and in `shared.testUsers`, is an `https` URL naming at least one app
  client;
- no environment's `issuers` names a test user pool, its own stage's or another's;
- an environment with `frontdoor.testUsers` is in a stage whose `shared.testUsers` is set;
- every environment trusts at least one issuer, counting the test user pool where it trusts test
  users;
- every domain's name follows the same rule as the names above, is used once in its environment,
  across all its domain accounts, and is short enough for its execution role's name to fit IAM's
  64 characters. See [checks](/flex-platform/domains/hosting/#checks);
- a stage's `domains` holds exactly the domains its environments host, disabled ones included,
  each once. A domain missing from it could never be released, and one no environment hosts
  would leave its repository named for a domain the stage no longer has. A repository's name is
  `<owner>/<repository>`, and its IDs are digits with no leading zero;
- every `promoteFrom` names another environment of its stage, the promotions lead back to an
  environment that publishes, and every domain an environment hosts is also hosted in the
  environment it is promoted from;
- every domain account's network lists at least two availability zones, each once, and each one
  the network has a layout for;
- every gateway's id is a name as above, used once in its account, and short enough for its
  function's name to fit Lambda's 64 characters and its role's IAM's 64. It names at least one
  hostname, and each passes
  [the allowlist's rules](/flex-platform/infrastructure/network/#the-allowlist). An upstream's
  secret is named by its full ARN in eu-west-2, with the six characters Secrets Manager adds, and
  its key by a key's ARN in eu-west-2, never an alias, since a policy naming anything else would
  match nothing. Each role ARN names a role, without a wildcard, once. A target is `null` or not
  empty.

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
  `{section}-{environment}` alone. A domain account's stack starts `domainaccount-`, not `domain-`:
  names may hold hyphens, so only a different first word keeps it from ever having a domain's
  stack's name. A log group is a path, `/flex/{section}/{environment}/{thing}`. A custom metric's
  namespace has the same form without the leading slash, `flex/{section}/{environment}/{thing}`,
  and its name is kebab-case. Where AWS requires a prefix, such as WAF's `aws-waf-logs-`, the name
  follows it. Each section builds its resources' names with functions in one module, such as
  `frontdoor/infra/src/names.ts`, which states the template too. Stack names are built in
  `infra/app`, beside each stack.
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
- **A value AWS generates crosses regions through `CrossRegionParameters`.** A name derived from
  config can't stand in for a value AWS generates, such as a function URL's host. Within a region,
  the stack that has the value writes it to SSM and its reader resolves it at deploy, as a domain's
  stack reads its account's
  [certificate ARN](/flex-platform/domains/hosting/#what-a-domain-account-provides).
  CloudFormation writes a parameter only in a stack's own region. So for a reader in another
  region, the stack that has the value uses `CrossRegionParameters`, from `infra/constructs`: a
  custom resource writes each value to a parameter in the reader's region, when the stack
  deploys, so synth stays offline. The value is the custom resource's own property, so it is
  written again when it changes and never otherwise, and a template is the same from one synth
  to the next. The reader uses `valueForStringParameter`, declares the dependency, and deploys
  with `--force` after the value changes.

  CloudFormation holds the custom resource, not the parameter, so these parameters are the one
  thing the stacks create that the [inventory](#tests) doesn't list. Each is under
  `/flex/cross-region/`, named by `crossRegionParameterName`, which is how one is told from a
  parameter nothing accounts for. A stack has one `CrossRegionParameters`, which takes its values
  by region: CDK runs every such custom resource in a stack in one function, which here runs as a
  role that may write only those parameters, and logs to a log group the stack names.

## Test users

Every stage has a Cognito user pool of test users, `shared-test-users`, in its shared account. It
is for testing an environment from outside the platform, such as a domain's tests or a developer's
machine: software signs in as a test user, and the Frontdoor, if its environment trusts the pool,
lets the token through like any other. Every stage has the pool, so its stacks are the same in
each.

A test user's username is whatever its creator chose, and Lambda@Edge passes a token's username on
as the caller's pairwise ID. So an environment trusts test users only where its config sets
`frontdoor.testUsers`, which adds the stage's `shared.testUsers` to its issuers, and validation
refuses a test user pool named in `issuers`. An environment real users reach never sets it.

- **Only an administrator creates a user.** There is no sign-up, no hosted sign-in, no account
  recovery and no MFA.
- **Every password is generated,** and the pool refuses one shorter than 64 characters. Its client,
  also `shared-test-users`, allows `USER_PASSWORD_AUTH` and refresh, and no other flow, so a test
  user signs in only with Cognito's public `InitiateAuth`, which needs no AWS credentials. Anyone
  may try a password there, so its length is what protects it.
- **cdk-nag's MFA and Plus plan findings are acknowledged** on the pool. No person signs in as a
  test user, and threat protection guards passwords people choose, while its adaptive checks would
  flag the same automation signing in again and again.

Cognito generates the pool's and the client's IDs, and the CloudFront Function and Lambda@Edge
have their issuers built in when they are synthesized. So config can name the pool only once it
exists. The pool is retained and protected from deletion, and the inventory snapshots hold its
logical ID, the one change that would make CloudFormation replace it. A new stage's pool is
created first, with `-c target=shared`, and its IDs written into `shared.testUsers` before the
stage's first full deploy. The stack outputs both, as `TestUsersIssuer` and `TestUsersClientId`,
and exports neither. `shared-identity` depends on nothing and nothing depends on it, so it
never holds up an environment's deploy.

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
| `ApiIamCheck` | `Flex-ApiIam` | `ProxyApi`, in `@repo/domain-infra` | Be an API Gateway method with IAM authorisation, so API Gateway verifies each request's SigV4 signature and holds the signer to the API's resource policy, which for a domain admits the Frontdoor's edge role alone |

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
`Product`, `System`, `Owner`, `ResourceOwner` and `Source`, plus `Stage` and
`flex:managed-by: flex-platform`, which marks a stack as one this app owns. A stack that sets one
of these keys itself keeps its own value, so a domain's stack can name its own `Owner`. The mark
is how the stacks the app has built are listed in an account, one that has left config included,
so it stays the same through any change to the tag set.

No tag changes on every deploy, such as a commit or a version. A stack tag propagates to the
stack's resources, so it would update all of those each time.

Tag keys follow two styles:

| Kind | Key | Example | Read by |
|---|---|---|---|
| Organisation and reporting | GDS UpperCamelCase | `Product`, `Owner`, `Source` | People and cost reports |
| Platform | `flex:` and lowercase kebab-case | `flex:managed-by` | The platform's own tooling |

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

The CDK packages (`infra/app`, `infra/constructs` and each section's `infra/`) run their test files
in shared workers, with `isolate: false` in each `vitest.config.ts`. Loading `aws-cdk-lib` is most
of a small test file's time, and a worker loads it once instead of once per file. In `infra/app`, a
stage that `synthesizedStage` builds is shared the same way. So a module and its state carry over
from one test file to the next, in no fixed order. A CDK test never mocks a
module, sets an environment variable or changes anything global, and builds whatever it changes
itself, with its own `cdkApp()`.

`infra/app` builds its fixture stages, in `test/helpers.ts`, and the committed stages, and checks
that:

- each committed environment's config, built again under a name, accounts and zones no
  environment has, gives the same templates, every property of every resource, once those are set
  aside. So nothing in a stack depends on which environment it is: a construct that branches on
  an environment's name or an account fails here. Only the hashes of what holds the identity, such
  as Lambda@Edge's code, which holds the routes, are set aside with it;
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
