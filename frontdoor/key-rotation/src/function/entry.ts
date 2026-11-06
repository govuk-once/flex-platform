// What Lambda runs. Only the build bundles this module: it replaces KEY_ROTATION_CONFIG with an
// environment's config.
import { awsPorts } from "./aws.ts";
import { createHandler } from "./handler.ts";
import type { KeyRotationConfig } from "./types.ts";

declare const KEY_ROTATION_CONFIG: KeyRotationConfig;

export const handler = createHandler(
  awsPorts(KEY_ROTATION_CONFIG, process.env.AWS_REGION ?? ""),
  () => new Date(),
);
