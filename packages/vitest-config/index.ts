import type { TestUserConfig } from "vitest/config";
import { defineConfig } from "vitest/config";

export function createVitestConfig(overrides: TestUserConfig = {}) {
  return defineConfig({
    test: {
      globals: false,
      environment: "node",
      // Scaffolded packages may not have tests yet; don't fail their `test` task over it.
      passWithNoTests: true,
      // Each package's own module cache, under its root. By default every package shares one at
      // the workspace root, and each run clears it when the lockfile changes, so packages tested
      // in parallel delete it under each other and fail with ENOTEMPTY.
      fsModuleCachePath: "node_modules/.vitest-cache",
      coverage: {
        provider: "v8",
        reporter: ["text", "lcov"],
      },
      ...overrides,
    },
  });
}
