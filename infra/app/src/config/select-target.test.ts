import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES } from "../../test/helpers.ts";
import { selectTarget } from "./select-target.ts";

const PROD = FIXTURE_STAGES[2];

describe("selectTarget", () => {
  it("builds the whole stage when no target is given", () => {
    expect(selectTarget(PROD, undefined)).toEqual({
      environments: PROD.environments,
      shared: true,
    });
  });

  it("builds one environment's stacks", () => {
    expect(selectTarget(PROD, "staging")).toEqual({
      environments: [PROD.environments[1]],
      shared: false,
    });
  });

  it("builds only the shared account's stacks", () => {
    expect(selectTarget(PROD, "shared")).toEqual({
      environments: [],
      shared: true,
    });
  });

  it.each(["qa", "", 42])("names the known targets for %j", (name) => {
    expect(() => selectTarget(PROD, name)).toThrow(
      `Unknown target ${JSON.stringify(name)} for platform-prod. Known targets: dev, staging, prod, shared`,
    );
  });
});
