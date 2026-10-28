import { createVitestConfig } from "@repo/vitest-config";

// Each test file synthesizes whole stages, and its first synth, and each run of bin/app.ts, loads
// most of aws-cdk-lib and cdk-nag. Under coverage, on a CI runner busy with every package's tests,
// a file's first test has taken over 30 seconds.
export default createVitestConfig({ testTimeout: 120_000 });
