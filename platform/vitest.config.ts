import { createVitestConfig } from "@repo/vitest-config";

export default createVitestConfig({
  exclude: ["test/e2e/**", "node_modules/**", "cdk.out/**"],
});
