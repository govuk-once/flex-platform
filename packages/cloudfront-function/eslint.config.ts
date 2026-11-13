import { base, cloudfrontFunction } from "@repo/eslint-config";
import { defineConfig } from "eslint/config";

// A function bundles everything under src/function, so all of it runs in that runtime. The build
// runs in Node.
export default defineConfig(...base, {
  files: ["src/function/**/*.ts"],
  ignores: ["**/*.test.ts"],
  ...cloudfrontFunction([]),
});
