import { createVitestConfig } from "@repo/vitest-config";

// The first synth in each test file, and each run of bin/app.ts, loads most of aws-cdk-lib and
// cdk-nag. That takes about a second on a laptop and several on a CI runner under coverage, close
// to Vitest's default of 5 seconds. Later synths take milliseconds.
export default createVitestConfig({ testTimeout: 30_000 });
