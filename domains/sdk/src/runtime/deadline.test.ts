import { describe, expect, it } from "vitest";

import { runBeforeDeadline } from "./deadline.ts";

describe("runBeforeDeadline", () => {
  it("gives what the run answers before the deadline", async () => {
    expect(await runBeforeDeadline(Date.now() + 1_000, () => "done")).toEqual({
      timedOut: false,
      value: "done",
    });
  });

  it("stops waiting at the deadline, and aborts the run's signal", async () => {
    let signal: AbortSignal | undefined;

    const outcome = await runBeforeDeadline(Date.now() + 20, (given) => {
      signal = given;

      return new Promise(() => undefined);
    });

    expect(outcome).toEqual({ timedOut: true });
    expect(signal?.aborted).toBe(true);
  });

  it("counts a run that fails because its signal aborted as timed out", async () => {
    const outcome = await runBeforeDeadline(
      Date.now() + 20,
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );

    expect(outcome).toEqual({ timedOut: true });
  });

  it("passes on a failure before the deadline", async () => {
    const failure = new Error("failed");

    await expect(
      runBeforeDeadline(Date.now() + 1_000, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("times out at once when the deadline has passed", async () => {
    const outcome = await runBeforeDeadline(
      Date.now() - 1,
      () => new Promise(() => undefined),
    );

    expect(outcome).toEqual({ timedOut: true });
  });
});
