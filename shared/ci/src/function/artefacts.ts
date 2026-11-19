// The artefacts table: each version a domain has uploaded, and the bundle it names. A bundle is
// the domain's, not an environment's, so a version is recorded once, whichever environment it was
// uploaded through, and is the same bundle in every environment it is released to.
//
// A version is claimed when its upload is signed, and names that bundle from then on. The table's
// policy lets no role but this function's record one, and none change or remove one.

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";

import type { CiUploads } from "./types.ts";

/** A version a domain uploaded, and the bundle it names. */
export interface Artefact {
  readonly domain: string;
  readonly version: string;
  /** The bundle's SHA-256, in lowercase hex. */
  readonly sha256: string;
  /** The run that uploaded it, for the record. A token may hold none. */
  readonly runId?: string | undefined;
  /** The commit the run was for. A token may hold none. */
  readonly commit?: string | undefined;
}

/**
 * Records the artefact, unless its version is recorded already, and answers the hash the version
 * names: this one's if it was recorded now, or the one recorded before.
 */
export type ClaimVersion = (artefact: Artefact) => Promise<string>;

export interface VersionClaimOptions {
  readonly uploads: CiUploads;
  /** The time now, in milliseconds, which a version is recorded at. */
  readonly now: () => number;
  readonly client?: DynamoDBClient;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function createVersionClaim(options: VersionClaimOptions): ClaimVersion {
  const { table, region } = options.uploads;
  const client = options.client ?? new DynamoDBClient({ region });

  return async (artefact) => {
    try {
      await client.send(
        new PutItemCommand({
          TableName: table,
          Item: {
            domain: { S: artefact.domain },
            version: { S: artefact.version },
            sha256: { S: artefact.sha256 },
            recordedAt: { N: String(options.now()) },
            ...(artefact.runId !== undefined && {
              runId: { S: artefact.runId },
            }),
            ...(artefact.commit !== undefined && {
              commit: { S: artefact.commit },
            }),
          },
          ConditionExpression: "attribute_not_exists(version)",
          // So a version recorded already says which bundle it names, without a second read.
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
      return artefact.sha256;
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      const held = error.Item?.sha256?.S;
      // Only this function records a version, always with a hash. Anything else isn't one to
      // compare with, so the request fails rather than taking it as either answer.
      if (held === undefined || !SHA256_HEX.test(held)) {
        throw new Error("The version's record holds no bundle's hash", {
          cause: error,
        });
      }
      return held;
    }
  };
}
