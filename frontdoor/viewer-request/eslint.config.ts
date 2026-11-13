import { base, cloudfrontFunction } from "@repo/eslint-config";
import { defineConfig } from "eslint/config";

export default defineConfig(...base, {
  files: ["src/function/**/*.ts"],
  ignores: ["**/*.test.ts"],
  // What any CloudFront Function uses, the functions that run in its runtime, and what the
  // frontdoor's functions share.
  ...cloudfrontFunction([
    "@repo/cloudfront-function",
    "@repo/cloudfront-js-utils",
    "@repo/frontdoor-shared",
  ]),
});
