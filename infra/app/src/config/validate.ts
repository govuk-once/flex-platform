import { isPlatformName } from "@repo/cloudfront-js-utils/is-platform-name";
import { executionRoleName, ROLE_NAME_LENGTH } from "@repo/domain-infra";
import type { TrustedIssuer } from "@repo/frontdoor-shared";
import { gatewayFunctionName } from "@repo/gateway-core";
import { gatewayRoleName } from "@repo/gateway-infra";
import {
  dnsAllowlist,
  NETWORK_REGION,
  networkZones,
} from "@repo/infra-constructs";

import { domainName } from "./domain-name.ts";
import { SHARED_TARGET } from "./select-target.ts";
import { trustedIssuers } from "./trusted-issuers.ts";
import type {
  DomainAccountConfig,
  EnvironmentConfig,
  GatewayConfig,
  RepositoryConfig,
  StageConfig,
  ZoneConfig,
} from "./types.ts";

const ACCOUNT_ID = /^\d{12}$/;

// A DNS name of lowercase labels, with at least one dot, and no trailing dot.
const DOMAIN_NAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// A secret's full ARN, in the gateways' region, ending in the six characters Secrets Manager adds
// to its name. A policy naming the secret without them would match nothing.
const SECRET_ARN = new RegExp(
  String.raw`^arn:aws:secretsmanager:${NETWORK_REGION}:\d{12}:secret:[\w/+=.@-]+-[A-Za-z0-9]{6}$`,
);

// A KMS key's ARN in the gateways' region, by its ID, multi-region or not. Never an alias.
const KEY_ARN = new RegExp(
  String.raw`^arn:aws:kms:${NETWORK_REGION}:\d{12}:key/(?:mrk-[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$`,
);

// A role's ARN, with no wildcard.
const ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/;

// A Route 53 hosted zone ID, as the console shows it, without `/hostedzone/`.
const ZONE_ID = /^Z[0-9A-Z]{1,31}$/;

// ACM limits a certificate's first domain name to 64 characters. The frontdoor's certificate and
// the shared account's are each for their zone's apex, and a domain account's is the wildcard
// under its zone.
const CERTIFICATE_NAME_LENGTH = 64;

// GitHub's `<owner>/<repository>`. An owner is letters, digits and hyphens. A repository may hold
// dots and underscores too.
const REPOSITORY_NAME =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

// One of GitHub's IDs as a token's claim holds it: digits, with no leading zero. Anything else
// would never equal a claim, and the repository could release nothing, with nothing to say why.
const GITHUB_ID = /^[1-9]\d*$/;

interface AccountUse {
  readonly account: string;
  readonly usedBy: string;
}

// Throws on the first problem. Every stage is checked, whichever one is being synthesized, so a
// mistake in one stage's config can't wait for that stage's deploy to be found.
export function validateStages(stages: readonly StageConfig[]): void {
  checkNames(
    "stage",
    stages.map((stage) => stage.name),
  );
  // Every stage's, so no environment in any stage can name one in its issuers.
  const testUserPools = new Set<string>();
  for (const stage of stages) {
    const pool = stage.shared.testUsers;
    if (pool !== null) {
      checkIssuer(`${stage.name} shared test users`, pool);
      testUserPools.add(pool.issuer);
    }
  }
  for (const stage of stages) {
    checkZone(`${stage.name} shared zone`, stage.shared.zone, (name) => name);
    checkNames(
      `${stage.name} environment`,
      stage.environments.map((environment) => environment.name),
    );
    for (const environment of stage.environments) {
      if (environment.name === SHARED_TARGET) {
        throw new Error(
          `${stage.name}: no environment may be named ${SHARED_TARGET}, which is the target that builds the shared account's stacks`,
        );
      }
      checkNames(
        `${stage.name}/${environment.name} domain account`,
        environment.domainAccounts.map((domainAccount) => domainAccount.name),
      );

      // Unique across the environment, not just the account: the Frontdoor routes by name.
      checkNames(
        `${stage.name}/${environment.name} domain`,
        domainsOf(environment),
      );

      checkEnvironment(
        `${stage.name}/${environment.name}`,
        stage,
        environment,
        testUserPools,
      );
      checkDomains(`${stage.name}/${environment.name}`, environment);
    }
    checkStageDomains(stage);
    checkRelease(stage);
  }
  checkAccounts(accountUses(stages));
}

// The stage's domains say who may release each one, so they are exactly the domains its
// environments host. One missing could never be released. One no environment hosts would leave
// its repository trusted to upload code for a domain the stage no longer has.
function checkStageDomains(stage: StageConfig): void {
  checkNames(
    `${stage.name} domain`,
    stage.domains.map(({ name }) => name),
  );
  const listed = new Set(stage.domains.map(({ name }) => name));
  const hosted = new Set<string>();
  for (const environment of stage.environments) {
    for (const domain of domainsOf(environment)) {
      if (!listed.has(domain)) {
        throw new Error(
          `${stage.name}/${environment.name}: the domain ${domain} is not in ${stage.name}'s domains, which say who may release it`,
        );
      }
      hosted.add(domain);
    }
  }
  for (const { name, repository } of stage.domains) {
    if (!hosted.has(name)) {
      throw new Error(
        `${stage.name}: the domain ${name} is in its domains, but no environment hosts it`,
      );
    }
    if (repository !== null) {
      checkRepository(`${stage.name} ${name} domain`, repository);
    }
  }
}

function checkRepository(
  at: string,
  { name, id, ownerId }: RepositoryConfig,
): void {
  if (!REPOSITORY_NAME.test(name)) {
    throw new Error(
      `${at}: its repository ${JSON.stringify(name)} must be <owner>/<repository>`,
    );
  }
  for (const [what, value] of [
    ["repository's ID", id],
    ["repository's owner's ID", ownerId],
  ] as const) {
    if (!GITHUB_ID.test(value)) {
      throw new Error(
        `${at}: its ${what} ${JSON.stringify(value)} must be digits, as GitHub gives it`,
      );
    }
  }
}

// Code enters a stage where an environment publishes, and reaches every other by promotion. So
// each promotion names another of the stage's environments, the promotions lead back to one that
// publishes, and a domain is hosted wherever it would be promoted from.
function checkRelease(stage: StageConfig): void {
  const environments = new Map(
    stage.environments.map((environment) => [environment.name, environment]),
  );
  for (const environment of stage.environments) {
    if (environment.release === "publish") continue;
    const at = `${stage.name}/${environment.name}`;
    const { promoteFrom } = environment.release;
    const source = environments.get(promoteFrom);
    if (source === undefined || source === environment) {
      throw new Error(
        `${at}: it promotes from ${JSON.stringify(promoteFrom)}, which must be another environment of ${stage.name}`,
      );
    }

    if (promotesInACircle(environments, environment)) {
      throw new Error(
        `${at}: its promotions never reach an environment that publishes`,
      );
    }

    const promotable = new Set(domainsOf(source));
    for (const domain of domainsOf(environment)) {
      if (!promotable.has(domain)) {
        throw new Error(
          `${at}: the domain ${domain} is not hosted in ${promoteFrom}, which it would be promoted from`,
        );
      }
    }
  }
}

// Whether following an environment's promotions comes back to one already passed. A promotion
// from an environment the stage doesn't have ends the walk: that is reported as its own problem.
function promotesInACircle(
  environments: ReadonlyMap<string, EnvironmentConfig>,
  environment: EnvironmentConfig,
): boolean {
  const seen = new Set<string>();
  let from: EnvironmentConfig | undefined = environment;
  while (from !== undefined && from.release !== "publish") {
    if (seen.has(from.name)) return true;
    seen.add(from.name);
    from = environments.get(from.release.promoteFrom);
  }
  return false;
}

function checkEnvironment(
  at: string,
  stage: StageConfig,
  environment: EnvironmentConfig,
  testUserPools: ReadonlySet<string>,
): void {
  checkZone(`${at} frontdoor zone`, environment.frontdoor.zone, (name) => name);
  for (const domainAccount of environment.domainAccounts) {
    checkZone(
      `${at} ${domainAccount.name} domain account zone`,
      domainAccount.zone,
      (name) => `*.${name}`,
    );
    checkNetwork(
      `${at} ${domainAccount.name} domain account network`,
      domainAccount,
    );
    checkGateways(
      `${at} ${domainAccount.name} domain account`,
      environment,
      domainAccount,
    );
  }
  checkTrust(at, stage, environment, testUserPools);
}

// A test user's username is whatever its creator chose, and the edge passes it on as the caller's
// pairwise ID. So an environment trusts test users only through `frontdoor.testUsers`, never by
// naming a test user pool in its issuers.
function checkTrust(
  at: string,
  stage: StageConfig,
  environment: EnvironmentConfig,
  testUserPools: ReadonlySet<string>,
): void {
  for (const issuer of environment.frontdoor.issuers) {
    checkIssuer(at, issuer);
    if (testUserPools.has(issuer.issuer)) {
      throw new Error(
        `${at}: the issuer ${issuer.issuer} is a test user pool, which an environment trusts only through frontdoor.testUsers`,
      );
    }
  }
  // Refuses trust in test users where the stage has no pool.
  if (trustedIssuers(stage, environment).length === 0) {
    throw new Error(`${at}: the frontdoor needs at least one trusted issuer`);
  }
}

function checkIssuer(at: string, { issuer, clientIds }: TrustedIssuer): void {
  if (!issuer.startsWith("https://")) {
    throw new Error(
      `${at}: the issuer ${JSON.stringify(issuer)} must be an https URL`,
    );
  }
  if (clientIds.length === 0) {
    throw new Error(`${at}: the issuer ${issuer} names no app client`);
  }
}

// Every domain's name, disabled ones included: a disabled domain keeps its stack and its name, so
// no other account in the environment may take it.
function domainsOf(environment: EnvironmentConfig): string[] {
  return environment.domainAccounts.flatMap(({ domains }) =>
    domains.map(domainName),
  );
}

// The environment's and the domain's names are each valid alone, but together can pass IAM's limit
// on the execution role's name, the longest of a domain's names that Lambda or IAM limits.
function checkDomains(at: string, environment: EnvironmentConfig): void {
  for (const domain of domainsOf(environment)) {
    const roleName = executionRoleName(environment.name, domain);

    if (roleName.length > ROLE_NAME_LENGTH) {
      throw new Error(
        `${at} ${domain} domain: its execution role's name ${roleName} is longer than IAM's ${ROLE_NAME_LENGTH} characters`,
      );
    }
  }
}

// The network construct refuses what it can't lay out; checked here so every stage's config is.
function checkNetwork(at: string, { network }: DomainAccountConfig): void {
  try {
    networkZones(network.availabilityZones);
  } catch (error) {
    throw new Error(`${at}: ${(error as Error).message}`, { cause: error });
  }
}

// A gateway's id names its function, and each name it connects to goes on the DNS allowlist, so both
// are checked here for every stage, as the network checks them for the one it builds.
function checkGateways(
  at: string,
  environment: EnvironmentConfig,
  { gateways }: DomainAccountConfig,
): void {
  checkNames(
    `${at} gateway`,
    gateways.map(({ id }) => id),
  );
  for (const gateway of gateways) {
    const { id, hostnames } = gateway;
    try {
      gatewayFunctionName(environment.name, id);
      gatewayRoleName(environment.name, id);
    } catch (error) {
      throw new Error(`${at} ${id} gateway: ${(error as Error).message}`, {
        cause: error,
      });
    }
    if (hostnames.length === 0) {
      throw new Error(
        `${at} ${id} gateway: it names no hostname, so it couldn't reach its upstream`,
      );
    }
    try {
      dnsAllowlist(hostnames);
    } catch (error) {
      throw new Error(`${at} ${id} gateway: ${(error as Error).message}`, {
        cause: error,
      });
    }
    checkUpstreamAccess(`${at} ${id} gateway`, gateway);
  }
}

// Each ARN feeds an endpoint's policy and the gateway's role exactly, so one that can't match
// what it names would leave the gateway refused, with nothing to say why.
function checkUpstreamAccess(
  at: string,
  { secret, target, roleArns }: GatewayConfig,
): void {
  if (secret !== "create") {
    if (!SECRET_ARN.test(secret.arn)) {
      throw new Error(
        `${at}: ${JSON.stringify(secret.arn)} is not a secret's full ARN in ${NETWORK_REGION}, ending in the six characters Secrets Manager adds`,
      );
    }
    if (!KEY_ARN.test(secret.keyArn)) {
      throw new Error(
        `${at}: ${JSON.stringify(secret.keyArn)} is not a KMS key's ARN in ${NETWORK_REGION}, by its ID`,
      );
    }
  }
  if (target === "") {
    throw new Error(`${at}: its target is empty; use null for none`);
  }
  for (const arn of roleArns) {
    if (!ROLE_ARN.test(arn)) {
      throw new Error(
        `${at}: ${JSON.stringify(arn)} is not a role's ARN, without a wildcard`,
      );
    }
  }
  if (new Set(roleArns).size !== roleArns.length) {
    throw new Error(`${at}: a role ARN is listed more than once`);
  }
}

function checkZone(
  at: string,
  zone: ZoneConfig,
  certificateName: (zoneName: string) => string,
): void {
  if (!DOMAIN_NAME.test(zone.name)) {
    throw new Error(
      `${at}: ${JSON.stringify(zone.name)} must be a DNS name of lowercase labels with at least one dot`,
    );
  }
  if (!ZONE_ID.test(zone.id)) {
    throw new Error(
      `${at}: ${JSON.stringify(zone.id)} is not a hosted zone ID, such as Z0411378AOM55J0BQQZI`,
    );
  }
  const name = certificateName(zone.name);
  if (name.length > CERTIFICATE_NAME_LENGTH) {
    throw new Error(
      `${at}: its certificate's name, ${name}, is longer than ACM's ${CERTIFICATE_NAME_LENGTH} characters`,
    );
  }
}

// A name becomes part of resource names and DNS labels, and picks out one entry.
function checkNames(kind: string, names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!isPlatformName(name)) {
      throw new Error(
        `The ${kind} name ${JSON.stringify(name)} must be 1 to 32 lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`The ${kind} name ${name} is used more than once`);
    }
    seen.add(name);
  }
}

// Every account in every stage, with where it's used.
function accountUses(stages: readonly StageConfig[]): AccountUse[] {
  return stages.flatMap((stage) => [
    { account: stage.shared.account, usedBy: `${stage.name} shared account` },
    ...stage.environments.flatMap((environment) => {
      const at = `${stage.name}/${environment.name}`;
      return [
        {
          account: environment.frontdoor.account,
          usedBy: `${at} frontdoor account`,
        },
        ...environment.domainAccounts.map((domainAccount) => ({
          account: domainAccount.account,
          usedBy: `${at} ${domainAccount.name} domain account`,
        })),
      ];
    }),
  ]);
}

// An account is used in exactly one place, in exactly one stage. A stage only trusts its own
// accounts, so an account used twice would let a change to one place reach the other.
function checkAccounts(uses: readonly AccountUse[]): void {
  const firstUse = new Map<string, string>();
  for (const { account, usedBy } of uses) {
    if (!ACCOUNT_ID.test(account)) {
      throw new Error(
        `${usedBy}: ${JSON.stringify(account)} is not a 12-digit account ID`,
      );
    }
    const existing = firstUse.get(account);
    if (existing !== undefined) {
      throw new Error(
        `${usedBy}: account ${account} is already the ${existing}`,
      );
    }
    firstUse.set(account, usedBy);
  }
}
