// Inlined rather than using @repo/vitest-config: that package depends on this one for its lint
// config, so importing it here would create a workspace dependency cycle
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    passWithNoTests: true,
  },
});
