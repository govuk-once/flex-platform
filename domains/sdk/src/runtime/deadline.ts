// A handler races the request's deadline. When the deadline passes, the SDK stops waiting and the
// handler's signal aborts, but its work is not stopped. The gateway client refuses a call made
// after the same deadline, so what the handler still does cannot reach a gateway.

/** How long before its invocation ends a request stops waiting, to answer in, as a gateway does. */
export const ANSWER_MARGIN_MS = 500;

// The longest a timer can be set for. Past it, `setTimeout` fires at once.
const MAX_TIMER_MS = 2 ** 31 - 1;

export type DeadlineOutcome<Value> =
  | { readonly timedOut: true }
  | { readonly timedOut: false; readonly value: Value };

/** Runs `run` until `deadline`, in epoch milliseconds, with a signal that aborts then. */
export async function runBeforeDeadline<Value>(
  deadline: number,
  run: (signal: AbortSignal) => Value | Promise<Value>,
): Promise<DeadlineOutcome<Value>> {
  const controller = new AbortController();

  let timer: ReturnType<typeof setTimeout> | undefined;

  const expired = new Promise<DeadlineOutcome<Value>>((resolve) => {
    const wait = Math.min(MAX_TIMER_MS, Math.max(0, deadline - Date.now()));

    timer = setTimeout(() => {
      controller.abort(
        new DOMException("The request's deadline passed", "TimeoutError"),
      );

      resolve({ timedOut: true });
    }, wait);
  });

  const ran = async (): Promise<DeadlineOutcome<Value>> => ({
    timedOut: false,
    value: await run(controller.signal),
  });

  // The signal aborts in the same turn as the deadline settles the race, so a run that fails
  // because its signal aborted, as one does when it passes the signal on, settles too late to
  // count: it ran out of time.
  try {
    return await Promise.race([ran(), expired]);
  } finally {
    clearTimeout(timer);
  }
}
