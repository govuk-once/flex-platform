// What Lambda runs. Only the build bundles this module: it replaces KEY_ROTATION_CONFIG with one
// kind's config in one environment.
import { awsPorts } from "./aws.ts";
import { createHandler } from "./handler.ts";
import { KEY_POLICIES } from "./policy.ts";
import type { KeyRotationConfig } from "./types.ts";

declare const KEY_ROTATION_CONFIG: KeyRotationConfig;

const policy = KEY_POLICIES[KEY_ROTATION_CONFIG.kind];

export const handler = createHandler(
  awsPorts(KEY_ROTATION_CONFIG, policy, process.env.AWS_REGION ?? ""),
  policy,
  () => new Date(),
);
