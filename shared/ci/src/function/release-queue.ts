// Finds an uploaded bundle, and asks the release worker to release it. The API answers at once:
// a first release creates a function in a VPC, which can take minutes, so the worker does it.
//
// The release is recorded in the release table first, which only this function's role may do,
// and the message names it by its key. The worker runs what the table records, so nothing else
// that can reach the worker or the queue can ask for a release.

import { randomBytes } from "node:crypto";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { HeadObjectCommand, NotFound, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  encodeReleaseMessage,
  parseReleaseRequest,
  releaseGroup,
  type ReleaseRequest,
} from "@repo/shared-release/request";
import {
  createReleaseTable,
  type ReleaseTable,
} from "@repo/shared-release/table";
import { uuidV7 } from "@repo/utils/uuid-v7";

import type { CiReleases, CiUploads } from "./types.ts";

/** The version of the object under a key, or `undefined` when there is none. */
export type FindBundle = (key: string) => Promise<string | undefined>;

/** Records the release and queues it, and answers its ID. */
export type QueueRelease = (request: ReleaseRequest) => Promise<string>;

export function createBundleFinder(
  uploads: CiUploads,
  s3 = new S3Client({ region: uploads.region }),
): FindBundle {
  return async (key) => {
    try {
      const { VersionId } = await s3.send(
        new HeadObjectCommand({ Bucket: uploads.bucket, Key: key }),
      );
      // The bucket keeps versions, so an object has one. One without isn't a bundle to release.
      return VersionId;
    } catch (error) {
      // S3 says an object isn't there, rather than refusing, because the role may list the
      // bucket.
      if (error instanceof NotFound) return undefined;
      throw error;
    }
  };
}

export interface ReleaseQueueOptions {
  readonly releases: CiReleases;
  readonly region: string;
  /** The time now, in milliseconds, which each release is recorded at. */
  readonly now: () => number;
  /** The random bytes in a release's ID. */
  readonly random?: () => Uint8Array;
  readonly table?: ReleaseTable;
  readonly sqs?: SQSClient;
}

export function createReleaseQueue(options: ReleaseQueueOptions): QueueRelease {
  const { releases, region } = options;
  const random = options.random ?? (() => randomBytes(10));
  const table =
    options.table ??
    createReleaseTable(new DynamoDBClient({ region }), releases.table);
  const sqs = options.sqs ?? new SQSClient({ region });

  return async (request) => {
    // What the worker will read the record back as, so none is recorded that it couldn't read.
    if (parseReleaseRequest(request) === undefined) {
      throw new TypeError("The release isn't one the worker could read");
    }
    const requestedAt = options.now();
    const id = uuidV7(requestedAt, random());
    const key = {
      environment: request.environment,
      domain: request.domain,
      id,
    };

    await table.create(id, request, requestedAt);
    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: releases.queueUrl,
          MessageBody: encodeReleaseMessage(key),
          MessageGroupId: releaseGroup(request),
          MessageDeduplicationId: id,
        }),
      );
    } catch (error) {
      // So the record doesn't stay queued for a release nothing will run: no message is behind
      // it, so it is final. The pipeline is answered with the queue's error and asks again,
      // whether or not this is recorded.
      await table
        .finish(
          key,
          { status: "refused", step: "queue", reason: "not-queued" },
          options.now(),
          "queued",
        )
        .catch(() => undefined);
      throw error;
    }
    return id;
  };
}
