import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { wafLogGroupName } from "@repo/frontdoor-infra";

import { selectStage } from "../../src/config/select-stage.ts";
import { STAGES } from "../../src/config/stages.ts";
import type { EnvironmentConfig } from "../../src/config/types.ts";
import {
  FRONTDOOR_REGION,
  frontdoorStackName,
} from "../../src/stacks/frontdoor.ts";
import type { EdgeEnvironment } from "./environment.ts";

const DEFAULT_VALID_PATH = "/app/hello/health";

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// Shaped like a Cognito access token for the environment's first trusted issuer. The CloudFront
// Function checks the shape and nothing more, so the signature is any base64url text.
function unsignedToken(environment: EnvironmentConfig): string {
  const [issuer] = environment.frontdoor.issuers;
  if (!issuer) throw new Error("The environment has no trusted issuer");
  return [
    base64url({ alg: "RS256", kid: "e2e" }),
    base64url({
      iss: issuer.issuer,
      client_id: issuer.clientIds[0],
      token_use: "access",
      exp: Math.floor(Date.now() / 1000) + 3600,
      username: "e2e",
    }),
    "c2lnbmF0dXJl",
  ].join(".");
}

// CloudFront names the distribution, so its name is the one value read back from the deployment.
async function distributionDomainName(
  environment: EnvironmentConfig,
): Promise<string> {
  const client = new CloudFormationClient({ region: FRONTDOOR_REGION });
  const stackName = frontdoorStackName(environment);
  const { Stacks } = await client.send(
    new DescribeStacksCommand({ StackName: stackName }),
  );
  const output = Stacks?.[0]?.Outputs?.find(
    (each) => each.OutputKey === "DistributionDomainName",
  )?.OutputValue;
  if (output === undefined) {
    throw new Error(`${stackName} has no DistributionDomainName output`);
  }
  return output;
}

/**
 * `STAGE` and `ENVIRONMENT` name the deployed edge to test; everything but the distribution's
 * name is derived from config as the app derives it. `FLEX_EDGE_URL` skips the lookup.
 */
export default async function setup({
  provide,
}: {
  provide: (key: "edgeEnvironment", value: EdgeEnvironment) => void;
}): Promise<void> {
  const stage = selectStage(STAGES, process.env.STAGE);
  const name = process.env.ENVIRONMENT;
  const environment = stage.environments.find((each) => each.name === name);
  if (!environment) {
    const known = stage.environments.map((each) => each.name).join(", ");
    throw new Error(
      `Set ENVIRONMENT to one of ${stage.name}'s environments: ${known}`,
    );
  }

  const url =
    process.env.FLEX_EDGE_URL ??
    `https://${await distributionDomainName(environment)}`;

  provide("edgeEnvironment", {
    url: url.replace(/\/$/, ""),
    wafLogGroupName: wafLogGroupName(environment.name),
    token: unsignedToken(environment),
    validPath: process.env.FLEX_EDGE_VALID_PATH ?? DEFAULT_VALID_PATH,
  });
}
