import { createVitestConfig } from "@repo/vitest-config";

// The first synth in a test file loads most of aws-cdk-lib, which takes seconds on a CI runner.
export default createVitestConfig({ testTimeout: 30_000 });
