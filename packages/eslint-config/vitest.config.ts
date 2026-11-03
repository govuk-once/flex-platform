// Inlined rather than using @repo/vitest-config: that package depends on this one for its lint
// config, so importing it here would create a workspace dependency cycle
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    passWithNoTests: true,
    // Its own module cache, as @repo/vitest-config gives every other package.
    fsModuleCachePath: "node_modules/.vitest-cache",
  },
});
