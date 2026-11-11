import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../test/helpers.ts";
import { STAGES } from "./config/stages.ts";
import { DEPLOY_WAVES, deployWaves } from "./deploy-waves.ts";
import { inventory } from "./inventory.ts";

const FRONTDOOR = "100000000002";
const DOMAIN = "100000000003";

describe("deployWaves", () => {
  it("deploys each stack after its dependencies, grouping each wave by account", () => {
    expect(
      deployWaves([
        {
          name: "domain",
          account: DOMAIN,
          dependencies: ["domainaccount", "network"],
        },
        { name: "domainaccount", account: DOMAIN, dependencies: [] },
        {
          name: "frontdoor",
          account: FRONTDOOR,
          dependencies: ["domain", "logs"],
        },
        { name: "logs", account: FRONTDOOR, dependencies: [] },
        { name: "network", account: DOMAIN, dependencies: [] },
      ]),
    ).toEqual([
      [
        { account: FRONTDOOR, stacks: ["logs"] },
        { account: DOMAIN, stacks: ["domainaccount", "network"] },
      ],
      [{ account: DOMAIN, stacks: ["domain"] }],
      [{ account: FRONTDOOR, stacks: ["frontdoor"] }],
    ]);
  });

  it("refuses a stage that needs more waves than the workflow has", () => {
    const chain = Array.from({ length: DEPLOY_WAVES + 1 }, (_, index) => ({
      name: `stack-${String(index)}`,
      account: DOMAIN,
      dependencies: index === 0 ? [] : [`stack-${String(index - 1)}`],
    }));

    expect(() => deployWaves(chain)).toThrow(
      `stack-${String(DEPLOY_WAVES)} deploys in wave ${String(DEPLOY_WAVES + 1)}`,
    );
  });

  it("refuses stacks that depend on each other", () => {
    expect(() =>
      deployWaves([
        { name: "a", account: DOMAIN, dependencies: ["b"] },
        { name: "b", account: DOMAIN, dependencies: ["a"] },
      ]),
    ).toThrow("cycle");
  });

  it("refuses a stack with no account ID", () => {
    expect(() =>
      deployWaves([
        { name: "a", account: "unknown-account", dependencies: [] },
      ]),
    ).toThrow('a is in "unknown-account", which is not an account ID');
  });

  it.each(
    [...FIXTURE_STAGES, ...STAGES].map((stage) => [stage.name, stage] as const),
  )("plans every stack of %s once, after its dependencies", (_, stage) => {
    const stacks = inventory(synthesizedStage(stage));
    const waves = deployWaves(stacks);

    const waveOf = new Map(
      waves.flatMap((wave, index) =>
        wave.flatMap(({ stacks: names }) =>
          names.map((name) => [name, index] as const),
        ),
      ),
    );
    expect([...waveOf.keys()].sort()).toEqual(
      stacks.map((stack) => stack.name).sort(),
    );
    for (const stack of stacks) {
      for (const dependency of stack.dependencies) {
        expect(waveOf.get(dependency)).toBeLessThan(
          waveOf.get(stack.name) ?? -1,
        );
      }
    }
  });
});
