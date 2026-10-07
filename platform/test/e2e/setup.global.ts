import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";

import type { EdgeEnvironment } from "./environment.ts";

const PLATFORM_REGION = "eu-west-2";

const DEFAULT_VALID_PATH = "/health";

function sanitiseStageName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 12);
}

async function readStackOutputs(stackName: string) {
  const client = new CloudFormationClient({ region: PLATFORM_REGION });
  const { Stacks } = await client.send(
    new DescribeStacksCommand({ StackName: stackName }),
  );
  const outputs = Stacks?.[0]?.Outputs;
  if (!outputs) {
    throw new Error(`Stack ${stackName} has no outputs in ${PLATFORM_REGION}`);
  }
  return new Map(
    outputs.flatMap((output) =>
      output.OutputKey !== undefined && output.OutputValue !== undefined
        ? [[output.OutputKey, output.OutputValue] as const]
        : [],
    ),
  );
}

/** From `FLEX_EDGE_URL` and `FLEX_EDGE_WAF_LOG_GROUP`, or the stage's stack outputs. */
export default async function setup({
  provide,
}: {
  provide: (key: "edgeEnvironment", value: EdgeEnvironment) => void;
}): Promise<void> {
  const validPath = process.env.FLEX_EDGE_VALID_PATH ?? DEFAULT_VALID_PATH;
  let url = process.env.FLEX_EDGE_URL;
  let wafLogGroupName = process.env.FLEX_EDGE_WAF_LOG_GROUP;

  if (url === undefined || wafLogGroupName === undefined) {
    const raw = process.env.STAGE ?? process.env.USER ?? "";
    const stage = sanitiseStageName(raw);
    if (stage === "") {
      throw new Error(
        "Set STAGE, or FLEX_EDGE_URL and FLEX_EDGE_WAF_LOG_GROUP, to say which edge to test",
      );
    }
    const outputs = await readStackOutputs(`${stage}-FlexEdge`);
    url ??= outputs.get("EdgeUrl");
    wafLogGroupName ??= outputs.get("WafLogGroupName");
  }

  if (url === undefined || wafLogGroupName === undefined) {
    throw new Error(
      "The edge stack's outputs do not name its URL and WAF log group",
    );
  }

  provide("edgeEnvironment", {
    url: url.replace(/\/$/, ""),
    wafLogGroupName,
    validPath,
  });
}
