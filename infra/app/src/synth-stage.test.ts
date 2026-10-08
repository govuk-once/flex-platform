import { describe, expect, it } from "vitest";

import { cdkApp, FIXTURE_STAGES } from "../test/helpers.ts";
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

  it("checks every stage, not only the one it builds", () => {
    const broken = [
      ...FIXTURE_STAGES,
      { ...FIXTURE_STAGES[0], name: "Platform-QA" },
    ];

    expect(() => synthStage(cdkApp({ stage: "platform-dev" }), broken)).toThrow(
      'The stage name "Platform-QA" must be',
    );
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
