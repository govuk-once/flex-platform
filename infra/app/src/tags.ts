import type { Stack } from "aws-cdk-lib";

import type { StageConfig } from "./config/types.ts";

export const PLATFORM_TAGS = {
  Product: "GOV.UK",
  System: "FLEX",
  Owner: "flex-platform",
  ResourceOwner: "flex-platform",
  Source: "https://github.com/govuk-once/flex-platform",
} as const;

// The prune step finds the stacks this app owns by this tag.
const PRUNE_MARKER = { "flex:managed-by": "flex-platform" } as const;

export function tagStack(stack: Stack, stage: StageConfig): void {
  const tags = { ...PLATFORM_TAGS, Stage: stage.name, ...PRUNE_MARKER };
  for (const [key, value] of Object.entries(tags)) {
    stack.tags.setTag(key, value);
  }
}
