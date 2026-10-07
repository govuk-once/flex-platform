import { createVitestConfig } from "@repo/vitest-config";

// Run by `test:e2e` against a deployed edge, never by `pnpm test`.
export default createVitestConfig({
  include: ["test/e2e/**/*.e2e.test.ts"],
  globalSetup: ["test/e2e/setup.global.ts"],
  // WAF logs can take minutes to arrive.
  testTimeout: 6 * 60 * 1000,
  hookTimeout: 60 * 1000,
  coverage: { enabled: false },
});
