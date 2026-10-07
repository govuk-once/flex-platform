import { App, Tags } from "aws-cdk-lib";

import { edgeGlobalStackName, edgeStackName, PLATFORM_TAGS } from "./config.ts";
import { resolveStage } from "./environment.ts";
import { FlexEdgeGlobalStack } from "./stacks/edge-global-stack.ts";
import { FlexEdgeStack } from "./stacks/edge-stack.ts";

export function createApp(env: NodeJS.ProcessEnv = process.env): App {
  const stage = resolveStage(env);
  const account = env.CDK_DEFAULT_ACCOUNT;
  if (account === undefined || account === "") {
    throw new Error(
      "Set CDK_DEFAULT_ACCOUNT to the account to deploy to; the CDK CLI sets it from the credentials in use",
    );
  }

  const app = new App();

  for (const [key, value] of Object.entries(PLATFORM_TAGS)) {
    Tags.of(app).add(key, value);
  }
  Tags.of(app).add("Environment", stage.environment);
  Tags.of(app).add("Stage", stage.name);

  const global = new FlexEdgeGlobalStack(app, edgeGlobalStackName(stage), {
    stage,
    account,
  });

  new FlexEdgeStack(app, edgeStackName(stage), {
    stage,
    account,
    webAclArn: global.webAcl.webAcl.attrArn,
    certificate: global.certificate,
    wafLogGroupName: global.webAcl.logGroupName,
  });

  return app;
}
