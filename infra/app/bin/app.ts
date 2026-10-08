import { App } from "aws-cdk-lib";

import { STAGES } from "../src/config/stages.ts";
import { synthStage } from "../src/synth-stage.ts";

synthStage(new App(), STAGES);
