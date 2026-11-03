import { cdkApp } from "@repo/infra-constructs";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../test/helpers.ts";
import { STAGES } from "./config/stages.ts";
import { validateStages } from "./config/validate.ts";
import { synthStage } from "./synth-stage.ts";

describe("synthStage", () => {
  it.each(FIXTURE_STAGES)(
    "synthesizes $name with the committed flags",
    (stage) => {
      const app = cdkApp({ stage: stage.name });
      synthStage(app, FIXTURE_STAGES);

      expect(() => app.synth()).not.toThrow();
    },
  );

  // A lookup would need credentials for the account, and answers with placeholders until it has
  // them. Synth adds an error for it, but a test that only synthesizes doesn't see that.
  it.each(
    [...FIXTURE_STAGES, ...STAGES].map((stage) => [stage.name, stage] as const),
  )("looks nothing up in an account to synthesize %s", (_, stage) => {
    expect(synthesizedStage(stage).manifest.missing ?? []).toEqual([]);
  });

  it("checks every stage, not only the one it builds", () => {
    const broken = [
      ...FIXTURE_STAGES,
      { ...FIXTURE_STAGES[0], name: "Platform-QA" },
    ];

    expect(() => synthStage(cdkApp({ stage: "platform-dev" }), broken)).toThrow(
      'The stage name "Platform-QA" must be',
    );
  });

  it("builds one environment when a target names it, and refuses one it doesn't know", () => {
    const [, , prod] = FIXTURE_STAGES;
    const app = cdkApp({ stage: prod.name, target: "dev" });
    synthStage(app, FIXTURE_STAGES);
    expect(app.synth().stacks.map((stack) => stack.stackName)).toEqual([
      "frontdoor-dev-edge-logs-eu-west-2",
      "network-dev-main",
      "domain-dev-main",
      "domain-dev-domain-a",
      "domain-dev-domain-b",
      "frontdoor-dev",
    ]);

    expect(() =>
      synthStage(cdkApp({ stage: prod.name, target: "qa" }), FIXTURE_STAGES),
    ).toThrow('Unknown target "qa" for platform-prod');
  });

  it("asks for a stage when none is given", () => {
    expect(() => synthStage(cdkApp(), FIXTURE_STAGES)).toThrow(
      "Pass the stage to build with -c stage=<name>",
    );
  });
});

describe("the committed stages", () => {
  it("are valid", () => {
    expect(() => validateStages(STAGES)).not.toThrow();
  });

  it.each(STAGES)("synthesize $name", (stage) => {
    const app = cdkApp({ stage: stage.name });
    synthStage(app, STAGES);

    expect(() => app.synth()).not.toThrow();
  });
});
