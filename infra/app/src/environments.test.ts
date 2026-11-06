import { cdkApp } from "@repo/infra-constructs";
import type { CloudAssembly } from "aws-cdk-lib/cx-api";
import { describe, expect, it } from "vitest";

import { synthesizedStage } from "../test/helpers.ts";
import { buildApp } from "./build-app.ts";
import { selectTarget } from "./config/select-target.ts";
import { STAGES } from "./config/stages.ts";
import type { EnvironmentConfig, StageConfig } from "./config/types.ts";

// Which environment a stack belongs to: its name, its accounts and their zones. Everything else in
// an environment's config is what it builds.
function identityOf(environment: EnvironmentConfig): Map<string, string> {
  const values = new Map([
    [environment.frontdoor.account, "{frontdoor account}"],
    [environment.frontdoor.zone.name, "{frontdoor zone}"],
    [environment.frontdoor.zone.id, "{frontdoor zone id}"],
  ]);
  for (const { name, account, zone } of environment.domainAccounts) {
    values.set(account, `{${name} account}`);
    values.set(zone.name, `{${name} zone}`);
    values.set(zone.id, `{${name} zone id}`);
  }
  return values;
}

// An environment's config under an identity no environment has, so nothing could branch on it:
// the config is unchanged, and the name, the accounts and the zones are the test's own.
function twin(environment: EnvironmentConfig): EnvironmentConfig {
  return {
    ...environment,
    name: "twin",
    frontdoor: {
      ...environment.frontdoor,
      account: "900000000000",
      zone: { name: "twin.flex-edge.example", id: "ZTWINEDGE" },
    },
    domainAccounts: environment.domainAccounts.map((domainAccount, index) => ({
      ...domainAccount,
      account: String(900000000001 + index),
      zone: {
        name: `twin.flex-${domainAccount.name}.example`,
        id: `ZTWIN${String(index)}`,
      },
    })),
  };
}

// The environment's templates by stack name, with its identity replaced by placeholders.
function templates(
  assembly: CloudAssembly,
  environment: EnvironmentConfig,
): Record<string, unknown> {
  const identity = identityOf(environment);
  const normalise = (text: string) => {
    let out = text;
    for (const [value, placeholder] of identity)
      out = out.replaceAll(value, placeholder);
    // The name anywhere, since CDK writes it into IDs with the hyphens taken out. Lambda@Edge's code
    // holds the environment's routes, and a Lambda version's ID and an API deployment's end in a
    // hash of what they deploy, so each of those hashes holds the identity too.
    return out
      .replaceAll(environment.name, "{environment}")
      .replace(/[0-9a-f]{64}\.zip/g, "{code}.zip")
      .replace(
        /((?:CurrentVersion|Deployment)[0-9A-F]{8})[0-9a-f]{32}/g,
        "$1{hash}",
      );
  };
  return Object.fromEntries(
    assembly.stacks
      .filter(({ stackName }) => stackName.split("-")[1] === environment.name)
      .map((stack) => [
        normalise(stack.stackName),
        JSON.parse(normalise(JSON.stringify(stack.template))) as unknown,
      ]),
  );
}

// Only config differs between environments, so an environment's config builds the same stacks
// whichever environment it is. One that builds differently, as with `if (prod)`, fails here.
describe("an environment", () => {
  it.each(
    STAGES.flatMap((stage) =>
      stage.environments.map(
        (environment) =>
          [`${stage.name}/${environment.name}`, stage, environment] as const,
      ),
    ),
  )("%s builds the same under another identity", (_, stage, environment) => {
    const app = cdkApp();
    const twinned: StageConfig = {
      ...stage,
      environments: [twin(environment)],
    };
    buildApp(app, twinned, selectTarget(twinned, undefined));

    expect(templates(app.synth(), twinned.environments[0]!)).toEqual(
      templates(synthesizedStage(stage), environment),
    );
  });
});
