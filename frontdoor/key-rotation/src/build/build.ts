import { buildLambdaFunction } from "@repo/lambda-function/build";

import { KEY_POLICIES } from "../function/policy.ts";
import type { KeyRotationConfig } from "../function/types.ts";

const ENTRY = new URL("../function/entry.ts", import.meta.url).pathname;

export { HANDLER } from "@repo/lambda-function/build";

// Synchronous, because CDK builds constructs synchronously. Returns the code of `index.js`, with
// every dependency bundled, the AWS SDK's included, so the function runs the versions tested
// here, and the config baked in.
export function buildKeyRotationFunction(config: KeyRotationConfig): string {
  checkConfig(config);
  return buildLambdaFunction({
    entry: ENTRY,
    define: { KEY_ROTATION_CONFIG: config },
  });
}

// Config is checked when it is built, so a mistake fails synth rather than every run.
export function checkConfig(config: KeyRotationConfig): void {
  if (!Object.hasOwn(KEY_POLICIES, config.kind)) {
    throw new Error(`No key policy is named ${JSON.stringify(config.kind)}`);
  }
}
