import { describe, expect, it } from "vitest";

import { outcomeForStatus } from "./outcomes.ts";

describe("outcomeForStatus", () => {
  it.each([
    [200, "ok"],
    [201, "created"],
    [202, "accepted"],
    [204, "no_content"],
  ])("maps %i to %s", (status, outcome) => {
    expect(outcomeForStatus(status)).toBe(outcome);
  });

  it.each([203, 206, 301, 302, 400, 500])("has no outcome for %i", (status) => {
    expect(outcomeForStatus(status)).toBeUndefined();
  });
});
