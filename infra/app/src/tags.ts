import { type IAspect, Stack } from "aws-cdk-lib";
import type { IConstruct } from "constructs";

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

/**
 * Tags every stack in the app, whoever creates it, with the platform's tags, its stage and the
 * prune marker. Tags go on stacks only: CloudFormation propagates a stack's tags to the resources
 * in it that support stack-tag propagation, and cdk.json's explicitStackTags keeps Tags.of() from
 * reaching stacks. A tag the stack sets itself keeps its value, so a domain's stack can name its
 * own Owner.
 */
export class StackTags implements IAspect {
  constructor(private readonly stage: StageConfig) {}

  public visit(node: IConstruct): void {
    if (!(node instanceof Stack)) return;
    const own = node.tags.tagValues();
    const tags = { ...PLATFORM_TAGS, Stage: this.stage.name, ...PRUNE_MARKER };
    for (const [key, value] of Object.entries(tags)) {
      if (own[key] === undefined) node.tags.setTag(key, value);
    }
  }
}
