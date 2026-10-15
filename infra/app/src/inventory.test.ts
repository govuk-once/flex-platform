import { cdkApp } from "@repo/infra-constructs";
import { sortedNames } from "@repo/utils/sorted-names";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../test/helpers.ts";
import { buildApp } from "./build-app.ts";
import { selectTarget } from "./config/select-target.ts";
import type { EnvironmentConfig, StageConfig } from "./config/types.ts";
import { inventory, type StackInventory } from "./inventory.ts";

// A version's logical ID carries its code's hash, and Lambda@Edge's code bakes in each
// environment's issuers, so it changes with any change to either. A new version replacing the
// old one is how Lambda@Edge deploys.
function withoutVersions(stacks: StackInventory[]): StackInventory[] {
  return stacks.map((stack) => ({
    ...stack,
    resources: stack.resources.filter(
      (resource) => resource.type !== "AWS::Lambda::Version",
    ),
  }));
}

function synthesized(stage: StageConfig): StackInventory[] {
  const app = cdkApp();
  buildApp(app, stage, selectTarget(stage, undefined));
  return withoutVersions(inventory(app.synth()));
}

// An environment's stacks, with its name and accounts replaced by what they stand for.
function environmentShape(
  stacks: readonly StackInventory[],
  environment: EnvironmentConfig,
) {
  const accounts = new Map([
    [environment.frontdoor.account, "{frontdoor}"],
    ...environment.domainAccounts.map(
      (domain) => [domain.account, `{domain:${domain.name}}`] as const,
    ),
  ]);
  // Stack names are {section}-{environment}, then any -{thing} and -{region}. Environment names
  // are platform names, so they hold nothing a regular expression reads specially.
  const environmentName = new RegExp(`^([a-z0-9]+)-${environment.name}(?=-|$)`);
  const named = (name: string) =>
    name.replace(environmentName, "$1-{environment}");
  const shapes = new Map(
    stacks
      .filter((stack) => accounts.has(stack.account))
      .map((stack) => [
        named(stack.name),
        {
          ...stack,
          name: named(stack.name),
          account: accounts.get(stack.account),
          dependencies: stack.dependencies.map(named),
        },
      ]),
  );
  // Re-sorted: replacing the name can change where a stack sorts.
  return sortedNames(shapes.keys()).map((name) => shapes.get(name));
}

describe("inventory", () => {
  // An environment built differently in one stage, such as with `if (prod)`, fails here.
  it("is the same for every environment in every stage, names and accounts aside", () => {
    const shapes = FIXTURE_STAGES.flatMap((stage) => {
      const stacks = withoutVersions(inventory(synthesizedStage(stage)));
      return stage.environments.map((environment) =>
        environmentShape(stacks, environment),
      );
    });

    expect(shapes[0]).not.toHaveLength(0);
    for (const shape of shapes) expect(shape).toEqual(shapes[0]);
  });

  // A changed logical ID replaces its resource, so the change shows in review.
  it.each(FIXTURE_STAGES.map((stage) => [stage.name, stage] as const))(
    "matches the committed inventory of %s",
    async (name, stage) => {
      const stacks = withoutVersions(inventory(synthesizedStage(stage)));

      await expect(`${JSON.stringify(stacks, null, 2)}\n`).toMatchFileSnapshot(
        `__snapshots__/inventory.${name}.json`,
      );
    },
  );

  // Config lists are in whatever order someone wrote them, so no logical ID may depend on it.
  it("changes no logical ID when every list in config is reversed", () => {
    const issuers = [
      {
        issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_first",
        clientIds: ["first-a", "first-b"],
      },
      {
        issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_second",
        clientIds: ["second-a", "second-b"],
      },
    ];
    const [, , prod] = FIXTURE_STAGES;
    const stage: StageConfig = {
      ...prod,
      environments: prod.environments.map((environment) => ({
        ...environment,
        frontdoor: { ...environment.frontdoor, issuers },
      })),
    };
    const reversed: StageConfig = {
      ...stage,
      environments: stage.environments.toReversed().map((environment) => ({
        ...environment,
        domainAccounts: environment.domainAccounts.toReversed(),
        frontdoor: {
          ...environment.frontdoor,
          issuers: issuers.toReversed().map((issuer) => ({
            ...issuer,
            clientIds: issuer.clientIds.toReversed(),
          })),
        },
      })),
    };

    expect(synthesized(reversed)).toEqual(synthesized(stage));
  });
});
