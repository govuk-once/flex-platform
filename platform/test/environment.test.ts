import { describe, expect, it } from "vitest";

import { resolveStage, sanitiseStageName } from "../src/environment.ts";

describe("sanitiseStageName", () => {
  it("lowercases, drops what a resource name refuses and truncates", () => {
    expect(sanitiseStageName("Liam.Jones_Feature-Branch")).toBe("liamjonesfea");
  });
});

describe("resolveStage", () => {
  it("reads an environment as a persistent stage in its own account", () => {
    expect(resolveStage({ STAGE: "production" })).toEqual({
      name: "production",
      environment: "production",
      persistent: true,
    });
  });

  it("reads any other name as an ephemeral stage in development", () => {
    expect(resolveStage({ STAGE: "pr-123" })).toEqual({
      name: "pr-123",
      environment: "development",
      persistent: false,
    });
  });

  it("falls back to the user's name", () => {
    expect(resolveStage({ USER: "Liam" })).toMatchObject({
      name: "liam",
      persistent: false,
    });
  });

  it("refuses to run without a stage", () => {
    expect(() => resolveStage({ STAGE: "", USER: undefined })).toThrow(
      "Set STAGE",
    );
    expect(() => resolveStage({})).toThrow("Set STAGE");
  });
});
