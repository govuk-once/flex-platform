import { afterEach, describe, expect, it, vi } from "vitest";

import {
  awsError,
  FakeTable,
  messageFor,
  queuedRecord,
  RELEASE_ID,
  REQUESTED_AT,
} from "../../test/helpers.ts";
import type { ReleaseRecord } from "../table.ts";
import type { SqsEvent } from "../worker/types.ts";
import { createDeadLetterHandler } from "./handler.ts";

const MESSAGE_ID = "059f36b4-87a3-44ab-83d2-661975830a7d";

// The clock, an hour after the release was asked for.
const NOW = REQUESTED_AT + 60 * 60 * 1000;

function event(body: string): SqsEvent {
  return { Records: [{ messageId: MESSAGE_ID, body }] };
}

function captureLogs() {
  const lines: unknown[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(JSON.parse(line));
  });
  return lines;
}

function handlerWith(table: FakeTable) {
  return createDeadLetterHandler({ table, now: () => NOW });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createDeadLetterHandler", () => {
  it.each<[string, Partial<ReleaseRecord>]>([
    [
      "failed at a step",
      {
        status: "failed",
        attempts: 3,
        step: "create-function",
        reason: "EniLimitExceeded",
      },
    ],
    ["stopped with its function", { status: "releasing", attempts: 3 }],
    ["never claimed", { status: "queued" }],
  ])(
    "gives up a release that %s, keeping why, and lets the message go",
    async (_, state) => {
      const logs = captureLogs();
      const table = new FakeTable(queuedRecord(state));

      const response = await handlerWith(table)(event(messageFor()));

      expect(response).toEqual({ batchItemFailures: [] });
      expect(table.record).toMatchObject({
        status: "abandoned",
        updatedAt: NOW,
        ...(state.step !== undefined && { step: state.step }),
        ...(state.reason !== undefined && { reason: state.reason }),
      });
      expect(logs).toEqual([
        expect.objectContaining({
          level: "ERROR",
          telemetry: {
            event: "release_abandoned",
            details: expect.objectContaining({
              releaseId: RELEASE_ID,
              status: state.status,
              attempts: state.attempts ?? 0,
            }) as unknown,
          },
        }),
      ]);
    },
  );

  it.each<[ReleaseRecord["status"]]>([
    ["released"],
    ["refused"],
    ["abandoned"],
  ])(
    "lets the message go for a release already %s, changing nothing",
    async (status) => {
      const logs = captureLogs();
      const table = new FakeTable(queuedRecord({ status }));

      const response = await handlerWith(table)(event(messageFor()));

      expect(response).toEqual({ batchItemFailures: [] });
      expect(table.calls).toEqual([]);
      expect(logs).toEqual([
        expect.objectContaining({
          level: "INFO",
          telemetry: expect.objectContaining({
            event: "release_not_abandoned",
          }) as unknown,
        }),
      ]);
    },
  );

  // A handler that stopped after recording leaves the message to come again.
  it("changes nothing the second time a message comes", async () => {
    captureLogs();
    const table = new FakeTable(queuedRecord({ status: "failed" }));
    const handle = handlerWith(table);

    await handle(event(messageFor()));
    const response = await handle(event(messageFor()));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(table.calls).toEqual(["abandon"]);
  });

  it.each(["get", "abandon"])(
    "gives the message back when the table fails to %s",
    async (call) => {
      const logs = captureLogs();
      const table = new FakeTable(queuedRecord({ status: "failed" }));
      table.failures.set(
        call,
        awsError("ProvisionedThroughputExceededException", "SYNTHETIC"),
      );

      const response = await handlerWith(table)(event(messageFor()));

      expect(response).toEqual({
        batchItemFailures: [{ itemIdentifier: MESSAGE_ID }],
      });
      expect(logs).toEqual([
        expect.objectContaining({
          telemetry: {
            event: "release_failed",
            details: expect.objectContaining({
              step: "abandon",
              reason: "ProvisionedThroughputExceededException",
            }) as unknown,
          },
        }),
      ]);
      expect(JSON.stringify(logs)).not.toContain("SYNTHETIC");
    },
  );

  it.each<[string, string, string]>([
    ["a message that names no release", "SYNTHETIC text", "release_invalid"],
    ["a release the table doesn't hold", messageFor(), "release_unknown"],
  ])("lets go of %s, naming nothing from it", async (_, body, logged) => {
    const logs = captureLogs();

    const response = await handlerWith(new FakeTable())(event(body));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(logs).toEqual([
      {
        level: "ERROR",
        message: "telemetry",
        telemetry: {
          event: logged,
          details: { messageId: MESSAGE_ID, durationMs: 0 },
        },
      },
    ]);
  });
});
