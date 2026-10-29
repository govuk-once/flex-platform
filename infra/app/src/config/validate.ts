import { domainFunctionName, FUNCTION_NAME_LENGTH } from "@repo/domain-infra";
import { gatewayFunctionName } from "@repo/gateway-infra";
import { dnsAllowlist, networkZones } from "@repo/infra-constructs";
import { isPlatformName } from "@repo/utils/is-platform-name";

import type {
  DomainAccountConfig,
  EnvironmentConfig,
  StageConfig,
  ZoneConfig,
} from "./types.ts";

const ACCOUNT_ID = /^\d{12}$/;

// A DNS name of lowercase labels, with at least one dot, and no trailing dot.
const DOMAIN_NAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// A Route 53 hosted zone ID, as the console shows it, without `/hostedzone/`.
const ZONE_ID = /^Z[0-9A-Z]{1,31}$/;

// ACM limits a certificate's first domain name to 64 characters. The frontdoor's certificate is
// for its zone's apex, and a domain account's is the wildcard under its zone.
const CERTIFICATE_NAME_LENGTH = 64;

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
  for (const stage of stages) {
    checkNames(
      `${stage.name} environment`,
      stage.environments.map((environment) => environment.name),
    );
    for (const environment of stage.environments) {
      checkNames(
        `${stage.name}/${environment.name} domain account`,
        environment.domainAccounts.map((domainAccount) => domainAccount.name),
      );

      // Unique across the environment, not just the account: the Frontdoor routes by name.
      checkNames(
        `${stage.name}/${environment.name} domain`,
        domainsOf(environment),
      );

      checkEnvironment(`${stage.name}/${environment.name}`, environment);
      checkDomains(`${stage.name}/${environment.name}`, environment);
    }
  }
  checkAccounts(accountUses(stages));
}

function checkEnvironment(at: string, environment: EnvironmentConfig): void {
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
  const { issuers } = environment.frontdoor;
  if (issuers.length === 0) {
    throw new Error(`${at}: the frontdoor needs at least one trusted issuer`);
  }
  for (const { issuer, clientIds } of issuers) {
    if (!issuer.startsWith("https://")) {
      throw new Error(
        `${at}: the issuer ${JSON.stringify(issuer)} must be an https URL`,
      );
    }
    if (clientIds.length === 0) {
      throw new Error(`${at}: the issuer ${issuer} names no app client`);
    }
  }
}

function domainsOf(environment: EnvironmentConfig): string[] {
  return environment.domainAccounts.flatMap(({ domains }) => domains);
}

// The environment's and the domain's names are each valid alone, but together can pass Lambda's
// limit on the function's name.
function checkDomains(at: string, environment: EnvironmentConfig): void {
  for (const domain of domainsOf(environment)) {
    const functionName = domainFunctionName(environment.name, domain);

    if (functionName.length > FUNCTION_NAME_LENGTH) {
      throw new Error(
        `${at} ${domain} domain: its function name ${functionName} is longer than Lambda's ${FUNCTION_NAME_LENGTH} characters`,
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
  for (const { id, hostnames } of gateways) {
    const functionName = gatewayFunctionName(environment.name, id);
    if (functionName.length > FUNCTION_NAME_LENGTH) {
      throw new Error(
        `${at} ${id} gateway: its function name ${functionName} is longer than Lambda's ${FUNCTION_NAME_LENGTH} characters`,
      );
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
