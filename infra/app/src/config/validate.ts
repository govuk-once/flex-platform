import { isPlatformName } from "@repo/utils/is-platform-name";

import type { EnvironmentConfig, StageConfig } from "./types.ts";

const ACCOUNT_ID = /^\d{12}$/;

// A DNS name of lowercase labels, with at least one dot: the edge adds a label in front of it.
const DOMAIN_NAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

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
      checkEnvironment(`${stage.name}/${environment.name}`, environment);
    }
  }
  checkAccounts(accountUses(stages));
}

function checkEnvironment(at: string, environment: EnvironmentConfig): void {
  if (!DOMAIN_NAME.test(environment.domainName)) {
    throw new Error(
      `${at}: the domain name ${JSON.stringify(environment.domainName)} must be a DNS name of lowercase labels with at least one dot`,
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
    { account: stage.sharedAccount, usedBy: `${stage.name} shared account` },
    ...stage.environments.flatMap((environment) => {
      const at = `${stage.name}/${environment.name}`;
      return [
        {
          account: environment.frontdoorAccount,
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
