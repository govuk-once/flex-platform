import { base, cloudfrontFunction } from "@repo/eslint-config";
import { defineConfig } from "eslint/config";

// Every function here runs in the cloudfront-js runtime as well as in Node, so the whole package
// is held to what that runtime has.
export default defineConfig(...base, {
  files: ["src/**/*.ts"],
  ignores: ["**/*.test.ts"],
  ...cloudfrontFunction([]),
});
