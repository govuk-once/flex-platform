import { createVitestConfig } from "@repo/vitest-config";

// The first synth in a worker loads most of aws-cdk-lib, which takes seconds on a CI runner.
// Test files share their workers instead of each starting its own, so aws-cdk-lib loads once per
// worker, not once per file. Modules and globals carry over from one file to the next: see
// /flex-platform/infrastructure/overview/#tests.
export default createVitestConfig({ testTimeout: 30_000, isolate: false });
