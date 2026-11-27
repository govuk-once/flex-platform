---
title: Infrastructure
description: The CDK app that deploys the platform, its stages and config, and the rules for adding to it.
---

The platform deploys with AWS CDK, from one app in `infra/app`. The app builds:

- the [Frontdoor](/flex-platform/frontdoor/overview/)'s stacks;
- each domain account's [network](/flex-platform/infrastructure/network/);
- the stacks that [host the domains](/flex-platform/domains/hosting/);
- each stage's [test users](#test-users).

This page describes the app and the rules every stack added to it follows.

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
| `shared-release` | Shared | eu-west-2 | Stage | The pipeline API's function, built with [who may release each domain](/flex-platform/domains/hosting/#what-the-api-checks), its URL, role and log group, the bucket [a domain's code is uploaded to](/flex-platform/domains/hosting/#uploading-a-bundle), the [release worker](/flex-platform/domains/hosting/#the-release-worker), its queues, role and log group, the [dead-letter worker](/flex-platform/domains/hosting/#the-dead-letter-worker), its role, log group and [alarms](/flex-platform/domains/hosting/#when-a-release-is-abandoned), the [table each version is recorded in](/flex-platform/domains/hosting/#the-artefacts-table), the [table each release is recorded in](/flex-platform/domains/hosting/#the-release-table), and the writer of the URL's host to us-east-1 |
| `shared-management` | Shared | us-east-1 | Stage | The certificate and DNS records, the distribution in front of [the pipeline API](/flex-platform/domains/hosting/#the-pipeline-api), its web ACL and CloudFront Function, and their log groups |

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

So an environment deploys in this order:

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

## Deploying

A merge to `main` deploys platform-dev through GitHub Actions, once the quality checks pass. No
person deploys from their own machine. platform-staging and platform-prod have no deploy yet.

Each account is bootstrapped for CDK in each region it deploys to:

- a frontdoor account and a shared account in us-east-1 and eu-west-2;
- a domain account in eu-west-2.

Each account trusts only itself. The platform team bootstraps the accounts, and gives each one a
role that the deploy assumes through GitHub's OIDC.

Each stage has a GitHub environment of the same name, which only `main` may deploy from. It holds
each account's role as a variable named `DEPLOY_ROLE_<account ID>`, such as
`DEPLOY_ROLE_553915472156`. If a deploy finds no variable for an account, it stops before it
deploys anything into that account.

A deploy (`.github/workflows/_deploy.yml`) synthesizes the stage once. It then deploys that cloud
assembly in waves. A stack goes in the wave after the last stack it depends on, so the order comes
from the dependencies the app records. `infra/app/bin/deploy-waves.ts` works it out.

Each wave runs one job per account, in parallel. Each job deploys only its own account's stacks,
as that account's role, with `cdk deploy --exclusively`. Without `--exclusively`, `cdk deploy`
also deploys a stack's dependencies, including those in another account, which the role can't
reach. A wave starts once every job in the wave before it has succeeded.

For platform-dev, the waves are:

| Wave | Shared account | Domain account | Frontdoor account |
|---|---|---|---|
| 1 | `shared-identity`, `shared-release` | `network-<environment>-<account>`, `domainaccount-<environment>-<account>` | `frontdoor-<environment>-edge-logs-eu-west-2`, `frontdoor-<environment>-caller-token-keys` |
| 2 | `shared-management` | `domain-<environment>-<domain>`, `gateway-<environment>-<account>-<id>` | |
| 3 | | | `frontdoor-<environment>` |

The workflow has three wave jobs. If a stage's stacks would need a fourth wave, its plan fails
before anything deploys. A test holds every stage in config to three waves. To add a wave, add a
job to the workflow and change `DEPLOY_WAVES`.

One deploy of a stage runs at a time. The others wait, oldest first.

A deploy never goes back to an older commit. Each account's job first finds the commit the stage
has, from the GitHub environment's latest successful deployment. The job fails unless its own
commit includes that commit (`infra/app/src/stage-check.ts`). A job can be run again on its own,
reusing its run's plan, so every job makes the check, not once per run. A commit can still go on
to a stage after newer commits have deployed elsewhere, as long as that stage has nothing newer.

Every account's job is a deployment of its own. So a commit counts as the stage's once any one of
its jobs succeeds, even if a later wave fails, because some of the stage's stacks now run it. What
the stage has is the newest commit any of its stacks run, not the last commit that deployed in
full. To put right a failed deploy, deploy it again or deploy a newer commit, never an older one.

## Config

Every stage's values are committed to this repository, under `infra/app/src/config/`, typed as
`StageConfig` in `types.ts`. Every field is required, so every difference between stages is
written out. A value goes in config whenever it can be known before deploy. A secret never does:
config names a secret, and never holds one.

```
config/
  stages.ts                every stage and its environments, and what each domain account hosts
  types.ts                 StageConfig and the types within it
  zones.ts                 every account's hosted zone, each named for the zone
  user-pools.ts            every Cognito user pool, with the app clients trusted in it
  domains.ts               every domain, once, with the repository that releases it
  utils/                   what reads config: choosing a stage and target, and checking it
```

```ts
StageConfig         { name, shared: { account, zone }, environments }
EnvironmentConfig   { name, release: "publish" | { promoteFrom },
                      frontdoor: { account, zone, issuers, testUserIssuer }, domainAccounts }
DomainAccountConfig { name, account, domains: [DomainConfig & { disabled?: true }], zone,
                      network: { availabilityZones }, gateways }
DomainConfig        { name, repository: { name, id, ownerId } | null }
GatewayConfig       { id, hostnames, placement, secret, target, roleArns, privateApiArns }
```

- A domain account's `name` goes into its stacks' and resources' names. Every stage names its
  first domain account `domain00`, which leaves room for more domain accounts in an environment.
- `domains` lists the domains a domain account hosts in the environment. Each is as `domains.ts`
  defines it, with `disabled: true` added if it is disabled. See
  [Hosting a domain](/flex-platform/domains/hosting/).
- A domain is defined once, in `domains.ts`, with the GitHub repository that may release it. The
  repository is `null` until it exists. One definition serves every environment that hosts the
  domain, because a domain's code is uploaded once and promoted.
  - A repository's `id` and `ownerId` are GitHub's IDs for it and for its owner, in digits. A
    repository keeps them when it is renamed or transferred. A repository created later under the
    same name has different IDs.
  - Its `name`, `<owner>/<repository>`, is for people to read.
- `release` says how a domain's code reaches the environment:
  - `"publish"` means new code enters the stage here. Only a publishing environment takes uploads
    and releases from a pipeline.
  - `{ promoteFrom }` names the environment whose released code it takes. Promotion is planned.
    See [releasing a domain's function](/flex-platform/domains/hosting/#releasing-a-domains-function).
- `zone` is the account's public hosted zone, as `{ name, id }`. The zones aren't the platform's.
  Another team creates one in each account, already delegated, named
  `<environment>.flex-<account role>.once.service.gov.uk`. An account writes records only into its
  own zone. The Frontdoor answers at its zone's apex. Each domain answers at
  `<domain>.<its domain account's zone>`. Nothing answers in a shared account's zone,
  `shared.zone`, yet.
- `network.availabilityZones` lists the zones the account's network uses, in any order. Each zone
  has its own NAT gateway. See
  [availability zones](/flex-platform/infrastructure/network/#availability-zones).
- `gateways` lists the gateways deployed in the account. Each domain account runs its own copy of
  a gateway that its domains call. Each gateway has:
  - `id`, which names its function, `gateway-<environment>-<id>`, and its package,
    `@repo/gateway-service-<id>`. `@repo/infra-app` depends on that package, so its tests wait on
    the gateway's codegen. Synth takes the bundle from `.gen/runtime/bundle.mjs` in that package.
  - `hostnames`, the names it connects to, which make up the network's DNS allowlist. See
    [the allowlist](/flex-platform/infrastructure/network/#the-allowlist).
  - `placement`, `isolated` or `private`. See [placement](/flex-platform/gateways/overview/#placement).
  - `secret`, which becomes `FLEX_UPSTREAM_SECRET_ARN`. It is `"create"` for a secret the
    gateway's stack creates, or `{ arn, keyArn }` for a secret its upstream holds, with the KMS key
    that encrypts it.
  - `target`, which becomes `FLEX_UPSTREAM_TARGET`. It is `null` if the driver takes the target
    from the secret.
  - `roleArns`, the roles it assumes to sign as, such as an upstream's role for `sigV4`.
  - `privateApiArns`, the private APIs in API Gateway that it calls, each by ARN with no stage or
    path, or none. See [private APIs](/flex-platform/infrastructure/network/#private-apis).

  The secrets, roles and private APIs feed the
  [endpoints' policies](/flex-platform/infrastructure/network/#endpoints) exactly. The secrets and
  roles also feed the gateway's role exactly.
- `issuers` lists the Cognito user pools whose access tokens the Frontdoor accepts. Each is given
  as its issuer URL, `https://cognito-idp.<region>.amazonaws.com/<pool ID>`, with the app client
  IDs the Frontdoor accepts from that pool. It never names a test user pool. Each pool is defined
  once, in `user-pools.ts`.
- `testUserIssuer` is the stage's [test user pool](#test-users), in the same form, if the
  Frontdoor also accepts its test users. Otherwise it is `null`.

Before building any stage, the app checks every stage's config. It refuses the config unless all
of these hold:

- Stage, environment and domain account names are 1 to 32 lowercase letters, digits and hyphens.
  Each starts with a letter, doesn't end with a hyphen, and is unique where it is used. This is a
  DNS label, narrowed, for three reasons:
  - names become DNS labels and parts of resource names;
  - a CloudFormation stack name must start with a letter;
  - a limit of 32 keeps names built from several of them within AWS limits, such as 64 characters
    for an IAM role.
- Every account ID is 12 digits. Each account is used in exactly one place in exactly one stage. A
  stage trusts only its own accounts, so an account shared between stages would let a change to
  one stage reach the other.
- Every zone's name is a DNS name of lowercase labels, with at least one dot and no trailing dot.
  Its ID is a hosted zone ID without `/hostedzone/`. ACM limits a certificate's name to 64
  characters. So these must fit within 64 characters: the Frontdoor's zone name, the shared
  account's zone name, and `*.` followed by each domain account's zone name.
- Every issuer, in `issuers` and as `testUserIssuer`, is an `https` URL naming at least one app
  client.
- No environment's `issuers` names a test user pool, whether its own stage's or another's.
- Every environment of a stage that trusts test users names the same `testUserIssuer`. No two
  stages name the same one, since each stage's pool is in its own shared account.
- Every environment trusts at least one issuer, counting the test user pool if it trusts test
  users.
- Every domain's name follows the same rule as the names above. It is used once in its
  environment, across all its domain accounts. It is short enough for its execution role's name to
  fit IAM's 64 characters. See [checks](/flex-platform/domains/hosting/#checks).
- A domain has the same one repository wherever its stage hosts it, or none anywhere, since one
  upload goes through every environment. A repository's name is `<owner>/<repository>`, and its IDs
  are digits with no leading zero.
- Every `promoteFrom` names another environment of its stage. The promotions lead back to an
  environment that publishes. Every domain an environment hosts is also hosted in the environment
  it is promoted from.
- Every domain account's network lists at least two availability zones, each once, and each one
  the network has a layout for.
- Every gateway's id is a name as above, used once in its account. It is short enough for its
  function's name to fit Lambda's 64 characters, and its role's name to fit IAM's 64.
- Every gateway names at least one hostname, and each passes
  [the allowlist's rules](/flex-platform/infrastructure/network/#the-allowlist).
- An upstream's secret is named by its full ARN in eu-west-2, with the six characters Secrets
  Manager adds. Its key is named by a key's ARN in eu-west-2, never an alias. A policy naming
  anything else would match nothing.
- Each role ARN names a role, without a wildcard, once.
- A target is `null` or not empty.

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
- **A value AWS generates crosses regions through `CrossRegionParameters`.** A name derived from
  config can't stand in for a value AWS generates, such as a function URL's host.
  - Within a region, the stack that has the value writes it to SSM, and its reader resolves it at
    deploy. A domain's stack reads its account's
    [certificate ARN](/flex-platform/domains/hosting/#what-a-domain-account-provides) this way.
  - CloudFormation writes a parameter only in a stack's own region. So for a reader in another
    region, the stack that has the value uses `CrossRegionParameters`, from `infra/constructs`. A
    custom resource writes each value to a parameter in the reader's region when the stack
    deploys, so synth stays offline.
  - The value is the custom resource's own property. So it is written again when it changes, and
    never otherwise, and a template is the same from one synth to the next.
  - The reader uses `valueForStringParameter` and declares the dependency. It deploys with
    `--force` after the value changes.

  `shared-management` reads the host of the pipeline API's function URL this way.

  CloudFormation holds the custom resource, not the parameter. So these parameters are the one
  thing the stacks create that the [inventory](#tests) doesn't list. Each is under
  `/flex/cross-region/`, named by `crossRegionParameterName`, which is how to tell one from a
  parameter nothing accounts for.

  A stack has one `CrossRegionParameters`, which takes its values by region. CDK runs every such
  custom resource in a stack in one function. Here that function runs as a role that may write only
  those parameters, and logs to a log group the stack names.

## A function behind CloudFront

A Lambda function that only CloudFront may call is reached at its function URL. Two functions in
`infra/constructs` set this up, one on each side:

- `cloudFrontFunctionUrl`, in the function's stack, gives the function a URL with IAM
  authorisation. Lambda then takes only requests signed with SigV4 by a caller IAM allows. It
  returns the URL's host.
  - The function's policy admits CloudFront alone, for any distribution in the function's account.
  - Lambda checks two actions for a call through a URL, `lambda:InvokeFunctionUrl` and
    `lambda:InvokeFunction`. So the policy allows both, and limits the second to calls through the
    URL, so CloudFront can't invoke the function any other way.
  - The policy names no one distribution. AWS chooses a distribution's ID, and the distribution
    needs the URL's host first, so naming it would make each wait for the other.
- `functionUrlOrigin`, in the distribution's stack, gives the origin for that host, reached over
  HTTPS and TLS 1.2. Its origin access control signs every request, and replaces any
  `Authorization` header a caller sent with CloudFront's own.

Lambda refuses a request sent straight to the URL from outside the account before the function
runs. Inside the account, as for any function, a principal whose own policy allows the call can
make it. So the function relies on what it checks itself, never on where a request came from.

The platform builds a distribution in us-east-1. If the function is in another region, its stack
passes the host on through [`CrossRegionParameters`](#rules-for-stacks-and-constructs).

Each function builds in the scope it is given, not in a construct of its own, because construct
IDs are a contract. The URL is the function's `FunctionUrl`, and a new ID would replace it, with a
new host. A synth [check](#checks) refuses a function URL with any other authorisation.

## A table's policy

Every DynamoDB table the platform holds gets its policy from `tablePolicy`, in `infra/constructs`.
The table's construct passes it each set of roles that uses the table, and what each set does to
the table's items. The policy then denies:

- to anyone outside those roles, everything but managing the table;
- to each set, everything but its own work.

Each deny names what it allows rather than what it refuses. So it also covers every other way to
reach an item: PartiQL statements, batch writes, exports, backups and restores, and any action
DynamoDB adds later. A deny in a resource's policy holds whatever a principal's own policy allows.
A table may add statements of its own, such as an allow for another account's roles, or a deny on
changing certain attributes.

Each deny names the table and every index of it, `table/<name>/index/*`. An index is a resource of
its own, which a statement naming only the table doesn't reach. So adding an index to a table
gives no way around its policy.

Managing the table means seeing its settings and policy, and doing what CloudFormation's
`AWS::DynamoDB::Table` handler does on an update: changing the table, its policy, its tags, its
point-in-time recovery and its contributor insights. The policy leaves out these handler actions:

- those that reach an item;
- those that copy items to a Kinesis stream or a replica;
- setting a time to live, `dynamodb:UpdateTimeToLive`, which no one may do. No table uses one.
  A time to live set on an attribute that holds a time, such as the moment a key starts, would
  have DynamoDB delete every item whose time has passed.

The policy leaves managing the table open to every role outside the sets. So it needn't name any
role a deploy runs as, which the platform doesn't choose, and no deploy is ever locked out of a
table. It also means a principal whose own policy allows `dynamodb:PutResourcePolicy` can rewrite
the table's policy. So who may do that in the account matters as much as the policy.

A role appears in one set only, since each set's deny would refuse the other set's work. A set may
name roles by a pattern, such as every gateway's role.

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
| `FunctionUrlIamCheck` | `Flex-FunctionUrlIam` | [`cloudFrontFunctionUrl`](#a-function-behind-cloudfront) | Be a Lambda function URL with IAM authorisation, so Lambda verifies each request's SigV4 signature and runs the function only for a signer IAM allows |

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
