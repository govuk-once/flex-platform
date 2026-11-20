import type { App } from "aws-cdk-lib";

import { buildApp } from "./build-app.ts";
import type { StageConfig } from "./config/types.ts";
import { selectStage } from "./config/utils/select-stage.ts";
import { selectTarget } from "./config/utils/select-target.ts";
import { validateStages } from "./config/utils/validate.ts";

export function synthStage(app: App, stages: readonly StageConfig[]): void {
  validateStages(stages);
  const stage = selectStage(stages, app.node.tryGetContext("stage"));
  buildApp(app, stage, selectTarget(stage, app.node.tryGetContext("target")));
}
