import type { App } from "aws-cdk-lib";

import { buildApp } from "./build-app.ts";
import { selectStage } from "./config/select-stage.ts";
import type { StageConfig } from "./config/types.ts";
import { validateStages } from "./config/validate.ts";

export function synthStage(app: App, stages: readonly StageConfig[]): void {
  validateStages(stages);
  buildApp(app, selectStage(stages, app.node.tryGetContext("stage")));
}
