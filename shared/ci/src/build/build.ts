import { isPlatformName } from "@repo/cloudfront-js-utils/is-platform-name";
import { buildSync } from "esbuild";

import type { CiConfig } from "../function/types.ts";

const ENTRY = new URL("../function/entry.ts", import.meta.url).pathname;

// The bundle is CommonJS, deployed as `index.js` with the handler `index.handler`.
export const HANDLER = "index.handler";

// Synchronous, because CDK builds constructs synchronously. Returns the code of `index.js`, with
// every dependency bundled and the config baked in.
export function buildCiFunction(config: CiConfig): string {
  checkConfig(config);
  const result = buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node26",
    define: { CI_CONFIG: JSON.stringify(config) },
    // Not minified, so the source locations a failure logs point at a line worth reading.
  });

  const output = result.outputFiles[0]?.text;
  if (output === undefined) throw new Error("esbuild produced no output");
  return output;
}

const HTTPS_URL = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._/-]*)?$/;

// A bucket's name, as it sits in an upload's address. No dots: S3's certificate covers one label.
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

// What DynamoDB takes as a table's name.
const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;

// GitHub's IDs, as its tokens hold them: digits, in a string.
const ID = /^\d{1,20}$/;

// Who may release what comes from config, so a bad entry fails the build rather than a request,
// or worse, allows one.
function checkConfig(config: CiConfig): void {
  for (const [name, value] of [
    ["issuer", config.issuer],
    ["keys address", config.keysUri],
    ["audience", config.audience],
  ] as const) {
    if (!HTTPS_URL.test(value)) {
      throw new Error(
        `The pipeline API's ${name}, ${JSON.stringify(value)}, is not an https address`,
      );
    }
  }

  const { bucket, region } = config.uploads;
  if (!BUCKET.test(bucket) || !REGION.test(region)) {
    throw new Error(
      `The pipeline API's bucket, ${JSON.stringify(bucket)} in ${JSON.stringify(region)}, is not a bucket's name and a region`,
    );
  }

  if (!TABLE_NAME.test(config.uploads.table)) {
    throw new Error(
      `The pipeline API's artefacts table, ${JSON.stringify(config.uploads.table)}, is not a table's name`,
    );
  }
  if (!TABLE_NAME.test(config.releases.table)) {
    throw new Error(
      `The pipeline API's release table, ${JSON.stringify(config.releases.table)}, is not a table's name`,
    );
  }
  if (!queueUrlIn(config.releases.queueUrl, region)) {
    throw new Error(
      `The pipeline API's release queue, ${JSON.stringify(config.releases.queueUrl)}, is not a FIFO queue's address in ${region}`,
    );
  }

  checkNames(
    "environment",
    config.environments.map(({ name }) => name),
  );
  checkNames(
    "domain",
    config.domains.map(({ name }) => name),
  );
  for (const environment of config.environments) {
    checkNames(`domain of ${environment.name}`, environment.domains);
  }
  for (const domain of config.domains) {
    if (!ID.test(domain.repositoryId) || !ID.test(domain.ownerId)) {
      throw new Error(
        `The repository of the domain ${domain.name} must be given by GitHub's IDs for it and its owner, in digits`,
      );
    }
  }
}

// A FIFO queue's address, as SQS gives it: its region, its account and its name.
function queueUrlIn(queueUrl: string, region: string): boolean {
  const match =
    /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\/\d{12}\/[A-Za-z0-9_-]{1,75}\.fifo$/.exec(
      queueUrl,
    );
  return match?.[1] === region;
}

// Each a name a path segment can hold, once: a second entry under a name would be ignored.
function checkNames(kind: string, names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!isPlatformName(name)) {
      throw new Error(
        `The ${kind} ${JSON.stringify(name)} is not a name the pipeline API's paths can hold`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`The ${kind} ${name} is listed twice`);
    }
    seen.add(name);
  }
}
