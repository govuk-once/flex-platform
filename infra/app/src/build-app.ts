import type { App } from "aws-cdk-lib";
import { Aspects, Stack, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import type { IConstruct } from "constructs";

import type { StageConfig } from "./config/types.ts";
import { FrontdoorStack } from "./stacks/frontdoor.ts";
import { tagStack } from "./tags.ts";

export function buildApp(app: App, stage: StageConfig): void {
  // Tags go on stacks only. CloudFormation propagates a stack's tags to the resources in it that
  // support stack-tag propagation, and cdk.json's explicitStackTags keeps Tags.of() from reaching
  // stacks.
  Aspects.of(app).add({
    visit(node: IConstruct) {
      if (node instanceof Stack) tagStack(node, stage);
    },
  });

  Validations.of(app).addPlugins(
    new AwsSolutionsChecks(app, { verbose: true }),
  );

  for (const environment of stage.environments) {
    new FrontdoorStack(app, environment);
  }
}
