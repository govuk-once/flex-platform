import { cdkApp } from "@repo/infra-constructs";
import { sortedNames } from "@repo/utils/sorted-names";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../test/helpers.ts";
import { buildApp } from "./build-app.ts";
import { selectTarget } from "./config/select-target.ts";
import { STAGES } from "./config/stages.ts";
import type { EnvironmentConfig, StageConfig } from "./config/types.ts";
import { inventory, type StackInventory } from "./inventory.ts";
import { networkStackName } from "./stacks/network.ts";

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

// An environment's stacks by kind, with the names and accounts config gave them replaced by what
// they stand for: the frontdoor's stacks, and each domain account's network. Environments have
// different numbers of domain accounts, so each kind is compared with its own kind.
function environmentShapes(
  stacks: readonly StackInventory[],
  environment: EnvironmentConfig,
) {
  // Stack names are {section}-{environment}, then any -{thing} and -{region}. Environment names
  // are platform names, so they hold nothing a regular expression reads specially.
  const environmentName = new RegExp(`^([a-z0-9]+)-${environment.name}(?=-|$)`);
  const named = (name: string) =>
    name.replace(environmentName, "$1-{environment}");
  const frontdoor = new Map(
    stacks
      .filter((stack) => stack.account === environment.frontdoor.account)
      .map((stack) => [
        named(stack.name),
        {
          ...stack,
          name: named(stack.name),
          account: "{frontdoor}",
          dependencies: stack.dependencies.map(named),
        },
      ]),
  );

  const byName = new Map(stacks.map((stack) => [stack.name, stack]));
  const networks = environment.domainAccounts.map((domainAccount) => {
    const name = networkStackName(environment, domainAccount);
    const stack = byName.get(name);
    if (stack === undefined) throw new Error(`No stack named ${name}`);
    return networkShape(stack, domainAccount.network.availabilityZones);
  });

  return {
    // Re-sorted: replacing the name can change where a stack sorts.
    frontdoor: sortedNames(frontdoor.keys()).map((name) => frontdoor.get(name)),
    networks,
  };
}

// A network with its availability zones set aside, since config lists different numbers of them:
// each zone's resources become one, named {zone}. CDK ends a logical ID with a hash of its
// construct path, which holds the zone, so the hash is set aside too.
function networkShape(stack: StackInventory, zones: readonly string[]) {
  const zone = new RegExp(
    zones.map((name) => name.replaceAll("-", "")).join("|"),
    "g",
  );
  const resources = new Map(
    stack.resources.map(({ logicalId, type }) => {
      const id = logicalId.replace(/[0-9A-F]{8}$/, "").replace(zone, "{zone}");
      return [`${id} ${type}`, { logicalId: id, type }];
    }),
  );
  return {
    ...stack,
    name: "network-{environment}-{account}",
    account: "{domain account}",
    resources: sortedNames(resources.keys()).map((key) => resources.get(key)),
  };
}

describe("inventory", () => {
  // An environment built differently in one stage, such as with `if (prod)`, fails here. The
  // committed stages are checked too, since only they hold the real environments' names.
  it.each([
    ["the fixture stages", FIXTURE_STAGES],
    ["the committed stages", STAGES],
  ] as const)(
    "builds each kind of stack the same in every environment in %s, names, accounts and zones aside",
    (_, stages) => {
      const shapes = stages.flatMap((stage) => {
        const stacks = withoutVersions(inventory(synthesizedStage(stage)));
        return stage.environments.map((environment) =>
          environmentShapes(stacks, environment),
        );
      });
      const frontdoors = shapes.map(({ frontdoor }) => frontdoor);
      const networks = shapes.flatMap(({ networks }) => networks);

      expect(frontdoors[0]).not.toHaveLength(0);
      expect(networks).not.toHaveLength(0);
      for (const kind of [frontdoors, networks]) {
        for (const shape of kind) expect(shape).toEqual(kind[0]);
      }
    },
  );

  // A changed logical ID replaces its resource, so the change shows in review. Built from the
  // committed stages, so a config change shows what it does to the real stacks too.
  it.each(STAGES.map((stage) => [stage.name, stage] as const))(
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
        domainAccounts: environment.domainAccounts
          .toReversed()
          .map((domainAccount) => ({
            ...domainAccount,
            network: {
              availabilityZones:
                domainAccount.network.availabilityZones.toReversed(),
            },
          })),
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
