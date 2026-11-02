import { cdkApp } from "@repo/infra-constructs";
import { Stack, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";

export const ACCOUNT = "123456789012";

export const ZONE = {
  zoneName: "sandbox.flex-domain00.example",
  hostedZoneId: "Z100000000003",
};

export function stackIn(region: string, nag = false): Stack {
  const app = cdkApp();

  if (nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app));

  return new Stack(app, "Test", { env: { account: ACCOUNT, region } });
}
