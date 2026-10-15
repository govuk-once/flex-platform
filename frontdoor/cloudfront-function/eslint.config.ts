import { base, cloudfrontFunction } from "@repo/eslint-config";
import { defineConfig } from "eslint/config";

export default defineConfig(...base, {
  files: ["src/function/**/*.ts"],
  ignores: ["**/*.test.ts"],
  // The rule for names in the infra's config, so the two can't drift.
  ...cloudfrontFunction(["@repo/utils/is-platform-name"]),
});
