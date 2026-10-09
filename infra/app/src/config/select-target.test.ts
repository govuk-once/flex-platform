import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES } from "../../test/helpers.ts";
import { selectTarget } from "./select-target.ts";

const PROD = FIXTURE_STAGES[2];

describe("selectTarget", () => {
  it("builds the whole stage when no target is given", () => {
    expect(selectTarget(PROD, undefined)).toEqual({
      shared: true,
      environments: PROD.environments,
    });
  });

  it("builds one environment's stacks and not the shared account's", () => {
    expect(selectTarget(PROD, "staging")).toEqual({
      shared: false,
      environments: [PROD.environments[1]],
    });
  });

  it("builds the shared account's stacks alone", () => {
    expect(selectTarget(PROD, "shared")).toEqual({
      shared: true,
      environments: [],
    });
  });

  it.each(["qa", "", 42])("names the known targets for %j", (name) => {
    expect(() => selectTarget(PROD, name)).toThrow(
      `Unknown target ${JSON.stringify(name)} for platform-prod. Known targets: shared, dev, staging, prod`,
    );
  });
});
