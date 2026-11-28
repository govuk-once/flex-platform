import type { ReleaseTable } from "../table.ts";
import {
  askedFor,
  eachMessage,
  messageLog,
  releaseFor,
} from "../worker/message.ts";
import { logRelease } from "../worker/telemetry.ts";
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
  return (event: SqsEvent): Promise<SqsBatchResponse> =>
    eachMessage(event, (messageId, body) => giveUp(options, messageId, body));
}

// Whether the message is done with. `false` gives it back to the queue.
async function giveUp(
  options: DeadLetterHandlerOptions,
  messageId: string,
  body: string,
): Promise<boolean> {
  const log = messageLog(messageId, options.now);
  const found = await releaseFor(options.table, body, log, "abandon");
  if (typeof found === "boolean") return found;
  const { key, record } = found;

  // The names are the table's from here on.
  const asked = { ...askedFor(record), status: record.status };
  let abandoned: boolean;
  try {
    abandoned = await options.table.abandon(key, options.now());
  } catch (error) {
    return log.failed("abandon", error, asked);
  }
  // Final or given up already, such as by the last attempt, or by this worker before it stopped.
  if (!abandoned) {
    logRelease("INFO", "release_not_abandoned", log.details(asked));
    return true;
  }
  logRelease("ERROR", "release_abandoned", {
    ...log.details(asked),
    attempts: record.attempts,
    ...(record.step !== undefined && { step: record.step }),
    ...(record.reason !== undefined && { reason: record.reason }),
  });
  return true;
}
