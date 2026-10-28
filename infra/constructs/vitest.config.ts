import { createVitestConfig } from "@repo/vitest-config";

// The first synth in a test file loads most of aws-cdk-lib, which takes tens of seconds on a busy
// CI runner under coverage.
export default createVitestConfig({ testTimeout: 120_000 });
