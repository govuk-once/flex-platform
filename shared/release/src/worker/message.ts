// What the release worker and the dead-letter worker do alike with each message a queue gives
// them: take them one at a time, read the release a message names, and log as they go.

import { describeUnexpectedError } from "@repo/utils/describe-unexpected-error";

import { parseReleaseMessage, type ReleaseKey } from "../request.ts";
import type { ReleaseRecord, ReleaseTable } from "../table.ts";
import { reasonOf } from "./release.ts";
import { logRelease, type ReleaseDetails } from "./telemetry.ts";
import type { SqsBatchResponse, SqsEvent } from "./types.ts";

/**
 * Handles each message in turn. `handle` answers whether the message is done with; one that isn't
 * is given back to the queue.
 */
export async function eachMessage(
  event: SqsEvent,
  handle: (messageId: string, body: string) => Promise<boolean>,
): Promise<SqsBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];
  for (const { messageId, body } of event.Records) {
    // In order, one at a time: a FIFO batch holds a group's messages in the order they were sent.
    const done = await handle(messageId, body); // NOSONAR
    if (!done) failures.push({ itemIdentifier: messageId });
  }
  return { batchItemFailures: failures };
}

export interface MessageLog {
  /** What every line about the message holds, with `more`. */
  readonly details: (more?: Partial<ReleaseDetails>) => ReleaseDetails;
  /** Logs a step that failed, which may not next time, and gives the message back. */
  readonly failed: (
    step: string,
    error: unknown,
    more?: Partial<ReleaseDetails>,
  ) => false;
}

export function messageLog(messageId: string, now: () => number): MessageLog {
  const started = now();
  const details = (more: Partial<ReleaseDetails> = {}): ReleaseDetails => ({
    messageId,
    durationMs: now() - started,
    ...more,
  });
  return {
    details,
    failed: (step, error, more = {}) => {
      logRelease("ERROR", "release_failed", {
        ...details(more),
        step,
        reason: reasonOf(error),
        frames: describeUnexpectedError(error).frames,
      });
      return false;
    },
  };
}

/**
 * The release a message names, as the table holds it. Otherwise whether the message is done with:
 * one that names no release, or one the table doesn't hold, is logged and let go, and a read that
 * failed is logged as `readStep` and given back.
 */
export async function releaseFor(
  table: ReleaseTable,
  body: string,
  log: MessageLog,
  readStep: string,
): Promise<{ key: ReleaseKey; record: ReleaseRecord } | boolean> {
  const key = parseReleaseMessage(body);
  if (key === undefined) {
    logRelease("ERROR", "release_invalid", log.details());
    return true;
  }
  let record: ReleaseRecord | undefined;
  try {
    record = await table.get(key);
  } catch (error) {
    return log.failed(readStep, error);
  }
  if (record === undefined) {
    logRelease("ERROR", "release_unknown", log.details());
    return true;
  }
  return { key, record };
}

/** What a release asked for, by the table's names, for the log. */
export function askedFor(record: ReleaseRecord): Partial<ReleaseDetails> {
  return {
    releaseId: record.id,
    environment: record.environment,
    domain: record.domain,
    version: record.version,
    sha256: record.sha256,
    runId: record.runId,
    commit: record.commit,
  };
}
