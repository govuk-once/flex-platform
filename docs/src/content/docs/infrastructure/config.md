---
title: Config
description: Every stage's committed values, the shape of each, and the checks the app holds them to before it builds anything.
---

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
    See [releasing a domain's function](/flex-platform/domains/releasing/).
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
    [the allowlist](/flex-platform/infrastructure/dns-filtering/#the-allowlist).
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
- `testUserIssuer` is the stage's [test user pool](/flex-platform/infrastructure/overview/#test-users), in the same form, if the
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
  [the allowlist's rules](/flex-platform/infrastructure/dns-filtering/#the-allowlist).
- An upstream's secret is named by its full ARN in eu-west-2, with the six characters Secrets
  Manager adds. Its key is named by a key's ARN in eu-west-2, never an alias. A policy naming
  anything else would match nothing.
- Each role ARN names a role, without a wildcard, once.
- A target is `null` or not empty.
