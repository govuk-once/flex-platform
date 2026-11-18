import { describe, expect, it } from "vitest";

import { FIXTURE_STAGES } from "../../test/helpers.ts";
import { functionReaders } from "./release-targets.ts";

const [, , PROD] = FIXTURE_STAGES;

describe("functionReaders", () => {
  it("names each domain account where a pipeline publishes, and its environment's functions", () => {
    expect(functionReaders(PROD)).toEqual([
      { account: "300000000003", functionNames: "domain-dev-*" },
    ]);
  });
});
