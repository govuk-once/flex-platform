import { isPlatformName } from "@repo/cloudfront-js-utils/is-platform-name";
import { buildSync } from "esbuild";

import type { DeadLetterConfig } from "../dead-letter/types.ts";
import type { ReleaseConfig, ReleaseTarget } from "../worker/types.ts";

const WORKER_ENTRY = new URL("../worker/entry.ts", import.meta.url).pathname;

const DEAD_LETTER_ENTRY = new URL("../dead-letter/entry.ts", import.meta.url)
  .pathname;

// Each bundle is CommonJS, deployed as `index.js` with the handler `index.handler`.
export const RELEASE_HANDLER = "index.handler";

// Synchronous, because CDK builds constructs synchronously. Each returns the code of `index.js`,
// with every dependency, the AWS SDK's clients included, bundled and the config baked in.
export function buildReleaseWorker(config: ReleaseConfig): string {
  checkConfig(config);
  return bundle(WORKER_ENTRY, { RELEASE_CONFIG: JSON.stringify(config) });
}

export function buildDeadLetterWorker(config: DeadLetterConfig): string {
  if (!REGION.test(config.region) || !TABLE_NAME.test(config.table)) {
    throw new Error(
      `The dead-letter worker's table, ${JSON.stringify(config.table)} in ${JSON.stringify(config.region)}, is not a table's name and a region`,
    );
  }
  return bundle(DEAD_LETTER_ENTRY, {
    DEAD_LETTER_CONFIG: JSON.stringify(config),
  });
}

function bundle(entry: string, define: Record<string, string>): string {
  const result = buildSync({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node24",
    define,
    // Not minified, so the source locations a failure logs point at a line worth reading.
  });

  const output = result.outputFiles[0]?.text;
  if (output === undefined) throw new Error("esbuild produced no output");
  return output;
}

const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

const ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_-]{1,64}$/;

// What DynamoDB takes as a table's name.
const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;

// What Lambda takes as a function's name: its own, not an ARN.
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

// A log group's or a parameter's name, as a path.
const PATH = /^(?:\/[A-Za-z0-9._-]+)+$/;

// What a release names comes from config, so a bad entry fails the build rather than a release.
function checkConfig(config: ReleaseConfig): void {
  if (!BUCKET.test(config.bucket) || !REGION.test(config.region)) {
    throw new Error(
      `The release worker's bucket, ${JSON.stringify(config.bucket)} in ${JSON.stringify(config.region)}, is not a bucket's name and a region`,
    );
  }
  if (!TABLE_NAME.test(config.table)) {
    throw new Error(
      `The release worker's table, ${JSON.stringify(config.table)}, is not a table's name`,
    );
  }
  const seen = new Set<string>();
  for (const target of config.targets) {
    checkTarget(target);
    const key = `${target.environment}/${target.domain}`;
    if (seen.has(key)) {
      throw new Error(`The release target ${key} is listed twice`);
    }
    seen.add(key);
  }
}

function checkTarget(target: ReleaseTarget): void {
  const name = `${JSON.stringify(target.environment)}/${JSON.stringify(target.domain)}`;
  const fault = targetFault(target);
  if (fault !== undefined) {
    throw new Error(`The release target ${name} has ${fault}`);
  }
}

function targetFault(target: ReleaseTarget): string | undefined {
  if (!isPlatformName(target.environment) || !isPlatformName(target.domain)) {
    return "a name the platform's config can't hold";
  }
  if (!ROLE_ARN.test(target.deployRoleArn)) return "no deploy role's ARN";
  if (!ROLE_ARN.test(target.executionRoleArn)) {
    return "no execution role's ARN";
  }
  if (!FUNCTION_NAME.test(target.functionName)) return "no function's name";
  for (const path of [
    target.logGroupName,
    target.subnetIdsParameter,
    target.securityGroupIdParameter,
  ]) {
    if (!PATH.test(path)) return `${JSON.stringify(path)} for a path`;
  }
  return undefined;
}
