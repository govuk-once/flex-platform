// What Lambda runs. Only the build bundles this module: it replaces DEAD_LETTER_CONFIG with a
// stage's config.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createReleaseTable } from "../table.ts";
import { createDeadLetterHandler } from "./handler.ts";
import type { DeadLetterConfig } from "./types.ts";

declare const DEAD_LETTER_CONFIG: DeadLetterConfig;

export const handler = createDeadLetterHandler({
  table: createReleaseTable(
    new DynamoDBClient({ region: DEAD_LETTER_CONFIG.region }),
    DEAD_LETTER_CONFIG.table,
  ),
  now: () => Date.now(),
});
