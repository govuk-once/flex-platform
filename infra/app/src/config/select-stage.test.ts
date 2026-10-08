import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES } from "../../test/helpers.ts";
import { selectStage } from "./select-stage.ts";

describe("selectStage", () => {
  it("returns the named stage", () => {
    expect(selectStage(FIXTURE_STAGES, "platform-staging")).toBe(
      FIXTURE_STAGES[1],
    );
  });

  it.each([undefined, "", 42])("asks for a stage when given %j", (name) => {
    expect(() => selectStage(FIXTURE_STAGES, name)).toThrow(
      "Pass the stage to build with -c stage=<name>. Known stages: platform-dev, platform-staging, platform-prod",
    );
  });

  it("names the known stages for an unknown one", () => {
    expect(() => selectStage(FIXTURE_STAGES, "platform-qa")).toThrow(
      'Unknown stage "platform-qa". Known stages: platform-dev, platform-staging, platform-prod',
    );
  });

  it("says when no stages are configured", () => {
    expect(() => selectStage([], "platform-dev")).toThrow("Known stages: none");
  });
});
