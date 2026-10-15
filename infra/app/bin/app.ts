import { cdkApp } from "@repo/infra-constructs";

import { STAGES } from "../src/config/stages.ts";
import { synthStage } from "../src/synth-stage.ts";

synthStage(cdkApp(), STAGES);
