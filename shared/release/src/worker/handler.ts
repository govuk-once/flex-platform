import { describeUnexpectedError } from "@repo/utils/describe-unexpected-error";

import { parseReleaseMessage } from "../request.ts";
import {
  type ReleaseKey,
  type ReleaseOutcome,
  type ReleaseRecord,
  type ReleaseTable,
  releaseTarget,
} from "../table.ts";
import {
  reasonOf,
  release,
  type ReleaseAws,
  ReleaseFailure,
  type TimeLeft,
} from "./release.ts";
import {
  logRelease,
  type ReleaseDetails,
  type ReleaseEventName,
} from "./telemetry.ts";
import type {
  LambdaContext,
  ReleaseConfig,
  ReleaseTarget,
  SqsBatchResponse,
  SqsEvent,
} from "./types.ts";

// What a release keeps back from its waits, in milliseconds: the time to move `live` and record
// how it went before Lambda stops the worker. A wait that runs out fails the attempt, and the
// queue gives it to another, which picks up where Lambda is.
const RECORDING_TIME_MS = 30_000;

export interface ReleaseHandlerOptions {
  readonly config: ReleaseConfig;
  readonly aws: ReleaseAws;
  readonly table: ReleaseTable;
  /** The time now, in milliseconds. */
  readonly now: () => number;
}

// Runs the release each message names, as the release table records it. Anything IAM lets invoke
// the function could write the event, so a message is only a key: what is released is the
// record's, which only the pipeline API writes. A final release isn't run again however often it
// is named. Any other may be, even while an attempt runs: Lambda is the record of what is
// deployed, and every step reads it before acting, so an attempt at what is done changes nothing.
//
// The outcome is recorded before the message is let go, so a message is let go only once the
// table says what happened. One that names no release is logged and let go, since there is
// nothing to record. One that might go differently next time is given back to the queue, which
// delivers it again and, after a few tries, moves it to the dead-letter queue. The handler never
// throws, so the runtime never prints an error, whose text can quote a request.
export function createReleaseHandler(options: ReleaseHandlerOptions) {
  // A map, because the names looked up come from the table.
  const targets = new Map<string, ReleaseTarget>(
    options.config.targets.map((target) => [
      releaseTarget(target.environment, target.domain),
      target,
    ]),
  );

  return async (
    event: SqsEvent,
    context: LambdaContext,
  ): Promise<SqsBatchResponse> => {
    const timeLeft = () =>
      context.getRemainingTimeInMillis() - RECORDING_TIME_MS;
    const failures: { itemIdentifier: string }[] = [];
    for (const { messageId, body } of event.Records) {
      // In order, one at a time: a FIFO batch holds a group's messages in the order they were sent.
      const done = await handle(options, targets, timeLeft, messageId, body); // NOSONAR
      if (!done) failures.push({ itemIdentifier: messageId });
    }
    return { batchItemFailures: failures };
  };
}

// Whether the message is done with, released or not. `false` gives it back to the queue.
async function handle(
  options: ReleaseHandlerOptions,
  targets: ReadonlyMap<string, ReleaseTarget>,
  timeLeft: TimeLeft,
  messageId: string,
  body: string,
): Promise<boolean> {
  const started = options.now();
  const details = (more: Partial<ReleaseDetails> = {}): ReleaseDetails => ({
    messageId,
    durationMs: options.now() - started,
    ...more,
  });
  // A table call that failed, which may not next time.
  const failed = (step: string, error: unknown, more = {}) => {
    logRelease("ERROR", "release_failed", {
      ...details(more),
      step,
      reason: reasonOf(error),
      frames: describeUnexpectedError(error).frames,
    });
    return false;
  };

  const key: ReleaseKey | undefined = parseReleaseMessage(body);
  if (key === undefined) {
    logRelease("ERROR", "release_invalid", details());
    return true;
  }

  let record: ReleaseRecord | undefined;
  try {
    record = await options.table.get(key);
  } catch (error) {
    return failed("read-record", error);
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
    version: record.version,
    sha256: record.sha256,
    runId: record.runId,
    commit: record.commit,
  };
  // Recorded over the claim, so never over what another writer recorded since.
  const finish = async (outcome: ReleaseOutcome) => {
    try {
      await options.table.finish(key, outcome, options.now(), "releasing");
      return true;
    } catch (error) {
      return failed("record-outcome", error, asked);
    }
  };

  let claimed: boolean;
  try {
    claimed = await options.table.claim(key, options.now());
  } catch (error) {
    return failed("claim", error, asked);
  }
  // Only a final release can't be claimed, so there is nothing more to record.
  if (!claimed) {
    logRelease("INFO", "release_not_claimed", {
      ...details(asked),
      status: record.status,
    });
    return true;
  }

  const target = targets.get(releaseTarget(record.environment, record.domain));
  if (target === undefined) {
    logRelease("ERROR", "release_unknown_target", details(asked));
    return finish({ status: "refused", reason: "unknown-target" });
  }

  let outcome: ReleaseOutcome;
  try {
    const released = await release(
      options.aws,
      options.config.bucket,
      target,
      record,
      timeLeft,
    );
    logRelease("INFO", "release_done", { ...details(asked), ...released });
    outcome = { status: "released", ...released };
  } catch (error) {
    const failure = error instanceof ReleaseFailure ? error : undefined;
    const retry = failure?.retry ?? true;
    const reason = failure?.reason ?? "unexpected";
    // A domain that releases quickly sees releases superseded, and nothing is wrong.
    const superseded = reason === "superseded";
    logRelease(superseded ? "INFO" : "ERROR", eventOf(retry, superseded), {
      ...details(asked),
      ...(failure !== undefined && { step: failure.step }),
      reason,
      frames: describeUnexpectedError(failure?.cause ?? error).frames,
    });
    outcome = {
      status: retry ? "failed" : "refused",
      step: failure?.step,
      reason,
    };
  }
  return (await finish(outcome)) && outcome.status !== "failed";
}

function eventOf(retry: boolean, superseded: boolean): ReleaseEventName {
  if (superseded) return "release_superseded";
  return retry ? "release_failed" : "release_refused";
}
