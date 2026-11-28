// The artefacts table: each version a domain has uploaded, and the bundle it names. A bundle is
// the domain's, not an environment's, so a version is recorded once, whichever environment it was
// uploaded through, and is the same bundle in every environment it is released to.
//
// A version is claimed when its upload is signed, and names that bundle from then on. The table's
// policy lets no role but this function's record one, and none change or remove one.

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { isSha256Hex } from "@repo/cloudfront-js-utils/is-sha256-hex";

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

/** The hash of the bundle a domain's version names, or `undefined` for a version not recorded. */
export type FindArtefact = (
  domain: string,
  version: string,
) => Promise<string | undefined>;

export interface VersionClaimOptions {
  readonly uploads: CiUploads;
  /** The time now, in milliseconds, which a version is recorded at. */
  readonly now: () => number;
  readonly client?: DynamoDBClient;
}

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
      return heldHash(error.Item?.sha256?.S);
    }
  };
}

export interface ArtefactFinderOptions {
  readonly uploads: CiUploads;
  readonly client?: DynamoDBClient;
}

export function createArtefactFinder(
  options: ArtefactFinderOptions,
): FindArtefact {
  const { table, region } = options.uploads;
  const client = options.client ?? new DynamoDBClient({ region });

  return async (domain, version) => {
    const { Item } = await client.send(
      new GetItemCommand({
        TableName: table,
        Key: { domain: { S: domain }, version: { S: version } },
        // A pipeline releases a version as soon as it uploads it.
        ConsistentRead: true,
      }),
    );
    return Item === undefined ? undefined : heldHash(Item.sha256?.S);
  };
}

// Only this function records a version, always with a hash. Anything else isn't one to use, so
// the request fails rather than taking it as an answer.
function heldHash(sha256: string | undefined): string {
  if (sha256 === undefined || !isSha256Hex(sha256)) {
    throw new Error("The version's record holds no bundle's hash");
  }
  return sha256;
}
