import {
  deployRoleName,
  domainFunctionName,
  executionRoleName,
  functionLogGroupName,
} from "@repo/domain-infra";
import {
  securityGroupIdParameterName,
  subnetIdsParameterName,
} from "@repo/infra-constructs";
import type { BundleReader } from "@repo/shared-infra";
import type { ReleaseTarget } from "@repo/shared-release";

import type { EnvironmentConfig, StageConfig } from "../types.ts";
import { stageDomains } from "./domains.ts";

// Where a pipeline publishes: the environments new code enters by a release. Elsewhere it will
// arrive by promotion, which the release worker doesn't do yet.
function publishing(stage: StageConfig): EnvironmentConfig[] {
  return stage.environments.filter(({ release }) => release === "publish");
}

/**
 * Each domain the release worker may release, in each environment a pipeline publishes to, and
 * everything a release of it names. Only a domain with a repository, since nothing else can ask
 * for its release. A disabled domain too: its code can be released while nothing is routed to it.
 */
export function releaseTargets(stage: StageConfig): ReleaseTarget[] {
  const registered = new Set(
    stageDomains(stage)
      .filter(({ repository }) => repository !== null)
      .map(({ name }) => name),
  );
  return publishing(stage).flatMap((environment) =>
    environment.domainAccounts.flatMap(({ account, domains }) =>
      domains
        .map(({ name }) => name)
        .filter((domain) => registered.has(domain))
        .map((domain) => ({
          environment: environment.name,
          domain,
          deployRoleArn: roleArn(
            account,
            deployRoleName(environment.name, domain),
          ),
          functionName: domainFunctionName(environment.name, domain),
          executionRoleArn: roleArn(
            account,
            executionRoleName(environment.name, domain),
          ),
          logGroupName: functionLogGroupName(environment.name, domain),
          subnetIdsParameter: subnetIdsParameterName(
            environment.name,
            "isolated",
          ),
          securityGroupIdParameter: securityGroupIdParameterName(
            environment.name,
            "domain",
          ),
        })),
    ),
  );
}

/**
 * What may read a bundle from the code bucket: every domain's function, and every domain's deploy
 * role, in each domain account of each environment a pipeline publishes to. By pattern, so the
 * bucket's policy holds one entry per account, however many domains each hosts.
 */
export function bundleReaders(stage: StageConfig): BundleReader[] {
  return publishing(stage).flatMap((environment) =>
    environment.domainAccounts.map(({ account }) => ({
      account,
      functionNames: domainFunctionName(environment.name, "*"),
      deployRoleNames: deployRoleName(environment.name, "*"),
    })),
  );
}

function roleArn(account: string, name: string): string {
  return `arn:aws:iam::${account}:role/${name}`;
}
