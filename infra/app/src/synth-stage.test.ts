import { cdkApp } from "@repo/infra-constructs";
import type { CloudAssembly } from "aws-cdk-lib/cx-api";
import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES, synthesizedStage } from "../test/helpers.ts";
import { STAGES } from "./config/stages.ts";
import { validateStages } from "./config/validate.ts";
import { synthStage } from "./synth-stage.ts";

const stackNames = (assembly: CloudAssembly) =>
  assembly.stacks.map((stack) => stack.stackName);

describe("synthStage", () => {
  // The stage with three environments, so one that built only the first would show.
  it("builds every environment of the stage it is given when no target names one", () => {
    const [, , prod] = FIXTURE_STAGES;
    const app = cdkApp({ stage: prod.name });
    synthStage(app, FIXTURE_STAGES);

    expect(stackNames(app.synth())).toEqual(stackNames(synthesizedStage(prod)));
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
    expect(stackNames(app.synth())).toEqual([
      "domainaccount-dev-main",
      "frontdoor-dev-caller-token-keys",
      "frontdoor-dev-edge-logs-eu-west-2",
      "network-dev-main",
      "domain-dev-domain-a",
      "domain-dev-domain-b",
      "gateway-dev-main-udp",
      "frontdoor-dev",
    ]);

    expect(() =>
      synthStage(cdkApp({ stage: prod.name, target: "qa" }), FIXTURE_STAGES),
    ).toThrow('Unknown target "qa" for platform-prod');
  });

  it("builds only the shared account's stacks for the shared target", () => {
    const [, , prod] = FIXTURE_STAGES;
    const app = cdkApp({ stage: prod.name, target: "shared" });
    synthStage(app, FIXTURE_STAGES);

    expect(stackNames(app.synth())).toEqual(["shared-identity"]);
  });

  it("asks for a stage when none is given", () => {
    expect(() => synthStage(cdkApp(), FIXTURE_STAGES)).toThrow(
      "Pass the stage to build with -c stage=<name>",
    );
  });
});

// Each stage is synthesized once, by `synthesizedStage`, and every test that reads it shares the
// result. A lookup would need credentials for the account, and answers with placeholders until it
// has them. Synth adds an error for it, but a test that only synthesizes doesn't see that.
describe("the fixture stages", () => {
  it.each(FIXTURE_STAGES)(
    "synthesize $name with the committed flags, looking nothing up in an account",
    (stage) => {
      expect(synthesizedStage(stage).manifest.missing ?? []).toEqual([]);
    },
  );
});

describe("the committed stages", () => {
  it("are valid", () => {
    expect(() => validateStages(STAGES)).not.toThrow();
  });

  it.each(STAGES)(
    "synthesize $name with the committed flags, looking nothing up in an account",
    (stage) => {
      expect(synthesizedStage(stage).manifest.missing ?? []).toEqual([]);
    },
  );
});
