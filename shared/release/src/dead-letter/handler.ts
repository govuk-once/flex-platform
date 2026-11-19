import { describeUnexpectedError } from "@repo/utils/describe-unexpected-error";

import { parseReleaseMessage } from "../request.ts";
import type { ReleaseRecord, ReleaseTable } from "../table.ts";
import { reasonOf } from "../worker/release.ts";
import { logRelease, type ReleaseDetails } from "../worker/telemetry.ts";
import type { SqsBatchResponse, SqsEvent } from "../worker/types.ts";

export interface DeadLetterHandlerOptions {
  readonly table: ReleaseTable;
  /** The time now, in milliseconds. */
  readonly now: () => number;
}

// Gives up each release whose message the queue moved to the dead-letter queue, after the worker
// tried it as often as the queue allows, or stopped each time without finishing. The table then
// says no more attempts are coming, which the release worker alone can't: an attempt that stopped
// with its function recorded nothing. A release final or given up already is left as it is. An
// attempt still running may yet release it, and `released` is recorded over `abandoned`, since
// Lambda says what is live.
//
// Anything IAM lets invoke the function could write the event, and nothing in it shows that the
// queue gave the release up. So giving a release up stops nothing: the release worker still claims
// and runs a release its queue gives it.
//
// The release is recorded as given up before the message is let go, and Lambda deletes a message
// only once the handler returns without giving it back. So a handler that stops after recording
// leaves the message to come again, and finds the release already given up the next time.
export function createDeadLetterHandler(options: DeadLetterHandlerOptions) {
  return async (event: SqsEvent): Promise<SqsBatchResponse> => {
    const failures: { itemIdentifier: string }[] = [];
    for (const { messageId, body } of event.Records) {
      // One at a time, as the release worker takes them.
      const done = await giveUp(options, messageId, body); // NOSONAR
      if (!done) failures.push({ itemIdentifier: messageId });
    }
    return { batchItemFailures: failures };
  };
}

// Whether the message is done with. `false` gives it back to the queue.
async function giveUp(
  options: DeadLetterHandlerOptions,
  messageId: string,
  body: string,
): Promise<boolean> {
  const started = options.now();
  const details = (more: Partial<ReleaseDetails> = {}): ReleaseDetails => ({
    messageId,
    durationMs: options.now() - started,
    ...more,
  });
  const failed = (error: unknown, more: Partial<ReleaseDetails> = {}) => {
    logRelease("ERROR", "release_failed", {
      ...details(more),
      step: "abandon",
      reason: reasonOf(error),
      frames: describeUnexpectedError(error).frames,
    });
    return false;
  };

  const key = parseReleaseMessage(body);
  if (key === undefined) {
    logRelease("ERROR", "release_invalid", details());
    return true;
  }

  let record: ReleaseRecord | undefined;
  try {
    record = await options.table.get(key);
  } catch (error) {
    return failed(error);
  }
  if (record === undefined) {
    logRelease("ERROR", "release_unknown", details());
    return true;
  }

  // The names are the table's from here on.
  const asked = {
    releaseId: record.id,
    environment: record.environment,
    domain: record.domain,
    sha256: record.sha256,
    runId: record.runId,
    commit: record.commit,
    status: record.status,
  };
  let abandoned: boolean;
  try {
    abandoned = await options.table.abandon(key, options.now());
  } catch (error) {
    return failed(error, asked);
  }
  // Final or given up already, such as by the last attempt, or by this worker before it stopped.
  if (!abandoned) {
    logRelease("INFO", "release_not_abandoned", details(asked));
    return true;
  }
  logRelease("ERROR", "release_abandoned", {
    ...details(asked),
    attempts: record.attempts,
    ...(record.step !== undefined && { step: record.step }),
    ...(record.reason !== undefined && { reason: record.reason }),
  });
  return true;
}
