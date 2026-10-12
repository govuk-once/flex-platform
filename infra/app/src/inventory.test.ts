import { cdkApp } from "@repo/infra-constructs";
import { sortedNames } from "@repo/utils/sorted-names";
import { CfnResource, Stack } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../test/helpers.ts";
import { buildApp } from "./build-app.ts";
import { domainsFor } from "./config/hosting.ts";
import { selectTarget } from "./config/select-target.ts";
import { STAGES } from "./config/stages.ts";
import type { EnvironmentConfig, StageConfig } from "./config/types.ts";
import {
  inventory,
  type ResourceInventory,
  type StackInventory,
} from "./inventory.ts";
import { domainStackName } from "./stacks/domain.ts";
import { domainAccountStackName } from "./stacks/domain-account.ts";

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

// An environment is built from units, each of which must be the same wherever it's built, names
// and accounts aside: the frontdoor's stacks, each domain account's shared part, and each domain,
// which is its own stack and its host in its account's stack. Environments differ only in which
// domains they list, as config does.
interface Unit {
  readonly stacks: unknown[];
  readonly resources: ResourceInventory[];
}

// CDK builds these logical IDs from the stack's name, or from a hash of the API as rendered, which
// holds the environment's names. They differ by environment by CDK's design, so only their number
// is compared.
const NAMED_BY_ENVIRONMENT = new Set([
  "AWS::ApiGateway::Deployment",
  "AWS::Lambda::Permission",
]);

// Built for the environment alone, so every stack in the app is one of its own.
function environmentUnits(
  stage: StageConfig,
  environment: EnvironmentConfig,
): Map<string, Unit> {
  const app = cdkApp();

  buildApp(app, stage, selectTarget(stage, environment.name));

  const accounts = new Map([
    [environment.frontdoor.account, "{frontdoor}"],
    ...environment.domainAccounts.map(
      ({ account, name }) => [account, `{domain:${name}}`] as const,
    ),
  ]);

  const unitOfStack = new Map([
    ...environment.domains.map(
      (domain) =>
        [
          domainStackName(environment, domain),
          `domain:${domain.config.name}`,
        ] as const,
    ),
    ...environment.domainAccounts.map(
      (domainAccount) =>
        [
          domainAccountStackName(environment, domainAccount),
          `account:${domainAccount.name}`,
        ] as const,
    ),
  ]);

  const hosted = new Set(environment.domains.map(({ config }) => config.name));

  // Stack names are {section}-{environment}, then any -{thing} and -{region}. Environment names
  // are platform names, so they hold nothing a regular expression reads specially.
  const environmentName = new RegExp(`^([a-z0-9]+)-${environment.name}(?=-|$)`);

  const named = (name: string) =>
    name.replace(environmentName, "$1-{environment}");

  const units = new Map<string, Unit>();

  const unit = (key: string): Unit => {
    if (!units.has(key)) units.set(key, { stacks: [], resources: [] });

    return units.get(key)!;
  };

  for (const stack of app.node.children.filter(
    (child): child is Stack => child instanceof Stack,
  )) {
    const key =
      unitOfStack.get(stack.stackName) ?? `frontdoor:${named(stack.stackName)}`;

    unit(key).stacks.push({
      name: named(stack.stackName),
      account: accounts.get(stack.account),
      region: stack.region,
      dependencies: sortedNames(
        stack.dependencies.map((dependency) => named(dependency.stackName)),
      ),
    });

    for (const resource of cfnResources(stack)) {
      // A domain's host is in its account's stack, under DomainAccount, in a scope named for it.
      const [, construct, scope] = resource.node.path.split("/");

      const host =
        construct === "DomainAccount" && hosted.has(scope!)
          ? `domain:${scope}`
          : undefined;

      unit(host ?? key).resources.push({
        logicalId: NAMED_BY_ENVIRONMENT.has(resource.cfnResourceType)
          ? "{named by environment}"
          : (stack.resolve(resource.logicalId) as string),
        type: resource.cfnResourceType,
      });
    }
  }

  for (const { resources } of units.values()) {
    resources.sort(
      (a, b) =>
        a.type.localeCompare(b.type) || a.logicalId.localeCompare(b.logicalId),
    );
  }

  return units;
}

function cfnResources(stack: Stack): CfnResource[] {
  return stack.node
    .findAll()
    .flatMap((node) =>
      node instanceof CfnResource &&
      node.cfnResourceType !== "AWS::Lambda::Version"
        ? [node]
        : [],
    );
}

describe("inventory", () => {
  // An environment built differently in one stage, such as with `if (prod)`, fails here: as an
  // extra unit, or as a unit that differs from the same unit elsewhere. The committed stages are
  // checked too, since only they hold the real environments' names.
  it.each([
    ["the fixture stages", FIXTURE_STAGES],
    ["the committed stages", STAGES],
  ] as const)(
    "builds each unit the same in every environment in %s, names and accounts aside",
    (_, stages) => {
      const environments = stages.flatMap((stage) =>
        stage.environments.map((environment) => ({
          environment,
          units: environmentUnits(stage, environment),
        })),
      );

      const frontdoorKeys = (units: Map<string, Unit>) =>
        [...units.keys()].filter((key) => key.startsWith("frontdoor:"));

      const [first] = environments;

      expect(frontdoorKeys(first!.units)).not.toHaveLength(0);

      const seen = new Map<string, Unit>();

      for (const { environment, units } of environments) {
        expect(sortedNames(units.keys())).toEqual(
          sortedNames([
            ...frontdoorKeys(first!.units),
            ...environment.domainAccounts
              .filter(
                (domainAccount) =>
                  domainsFor(domainAccount, { environment }).length > 0,
              )
              .map(({ name }) => `account:${name}`),
            ...environment.domains.map(({ config }) => `domain:${config.name}`),
          ]),
        );

        for (const [key, unit] of units) {
          if (!seen.has(key)) seen.set(key, unit);

          expect(unit, key).toEqual(seen.get(key));
        }
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
        domainAccounts: environment.domainAccounts.toReversed(),
        domains: environment.domains.toReversed(),
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
