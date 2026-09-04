import type { TestUserConfig } from "vitest/config";
import { defineConfig } from "vitest/config";

export function createVitestConfig(overrides: TestUserConfig = {}) {
  return defineConfig({
    test: {
      globals: false,
      environment: "node",
      // Scaffolded packages may not have tests yet; don't fail their `test` task over it.
      passWithNoTests: true,
      coverage: {
        provider: "v8",
        reporter: ["text", "lcov"],
      },
      ...overrides,
    },
  });
}
