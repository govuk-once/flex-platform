import { base, cloudfrontFunction } from "@repo/eslint-config";
import { defineConfig } from "eslint/config";

// The CloudFront Function bundles this package, so all of it runs in that runtime.
export default defineConfig(...base, {
  files: ["src/**/*.ts"],
  ignores: ["**/*.test.ts"],
  ...cloudfrontFunction([]),
});
