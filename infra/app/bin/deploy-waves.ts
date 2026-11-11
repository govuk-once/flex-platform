// Plans a deploy from a synthesized cloud assembly: `tsx bin/deploy-waves.ts <cdk.out> <file>`.
// Appends `wave1=<json>` to `wave<DEPLOY_WAVES>=<json>` to the file, which is $GITHUB_OUTPUT in the
// deploy workflow. Each is a list of `{ account, stacks }`, the stacks space-separated as
// `cdk deploy` takes them, and an empty list for a wave with nothing in it.

import { appendFileSync } from "node:fs";

import { CloudAssembly } from "aws-cdk-lib/cx-api";

import { DEPLOY_WAVES, deployWaves } from "../src/deploy-waves.ts";
import { inventory } from "../src/inventory.ts";

const [assemblyDirectory, outputFile] = process.argv.slice(2);
if (assemblyDirectory === undefined || outputFile === undefined) {
  throw new Error(
    "Usage: deploy-waves.ts <cloud assembly directory> <output file>",
  );
}

const waves = deployWaves(inventory(new CloudAssembly(assemblyDirectory)));

const lines = Array.from({ length: DEPLOY_WAVES }, (_, index) => {
  const wave = (waves[index] ?? []).map(({ account, stacks }) => ({
    account,
    stacks: stacks.join(" "),
  }));
  return `wave${String(index + 1)}=${JSON.stringify(wave)}\n`;
});
appendFileSync(outputFile, lines.join(""));
process.stdout.write(lines.join(""));
