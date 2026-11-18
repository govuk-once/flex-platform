import { domainFunctionName } from "@repo/domain-infra";
import type { FunctionReader } from "@repo/shared-infra";

import type { EnvironmentConfig, StageConfig } from "./types.ts";

// Where a pipeline publishes: the environments new code enters by a release. Elsewhere it will
// arrive by promotion, which the release worker doesn't do yet.
function publishing(stage: StageConfig): EnvironmentConfig[] {
  return stage.environments.filter(({ release }) => release === "publish");
}

/**
 * The functions Lambda may load a bundle from the code bucket for: every domain's, in each
 * domain account of each environment a pipeline publishes to.
 */
export function functionReaders(stage: StageConfig): FunctionReader[] {
  return publishing(stage).flatMap((environment) =>
    environment.domainAccounts.map(({ account }) => ({
      account,
      functionNames: domainFunctionName(environment.name, "*"),
    })),
  );
}
