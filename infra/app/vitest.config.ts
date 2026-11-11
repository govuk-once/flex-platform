import { createVitestConfig } from "@repo/vitest-config";

// A worker's first synth of a whole stage, and each run of bin/app.ts, loads most of aws-cdk-lib
// and cdk-nag, which takes about ten seconds on a CI runner under coverage.
// Test files share their workers instead of each starting its own, so aws-cdk-lib loads once per
// worker, not once per file. Modules and globals carry over from one file to the next: see
// /flex-platform/infrastructure/overview/#tests.
// A stage synthesized by `synthesizedStage` is shared the same way.
export default createVitestConfig({ testTimeout: 30_000, isolate: false });
