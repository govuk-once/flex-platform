// What Lambda runs. Only the build bundles this module: it replaces RELEASE_CONFIG with a stage's
// config.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createReleaseTable } from "../table.ts";
import { createReleaseAws, releaseClients } from "./aws.ts";
import { createReleaseHandler } from "./handler.ts";
import type { ReleaseConfig } from "./types.ts";

declare const RELEASE_CONFIG: ReleaseConfig;

export const handler = createReleaseHandler({
  config: RELEASE_CONFIG,
  aws: createReleaseAws(releaseClients(RELEASE_CONFIG.region)),
  table: createReleaseTable(
    new DynamoDBClient({ region: RELEASE_CONFIG.region }),
    RELEASE_CONFIG.table,
  ),
  now: () => Date.now(),
});
