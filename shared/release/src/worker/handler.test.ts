import { afterEach, describe, expect, it, vi } from "vitest";

import {
  awsError,
  COMMIT,
  CONFIG,
  fakeAws,
  FakeLambda,
  FakeTable,
  messageFor,
  queuedRecord,
  RELEASE_ID,
  releaseIdAt,
  REQUEST,
  REQUESTED_AT,
  SHA256,
} from "../../test/helpers.ts";
import { createReleaseHandler } from "./handler.ts";
import type { ReleaseAws } from "./release.ts";
import type { SqsEvent } from "./types.ts";

const MESSAGE_ID = "059f36b4-87a3-44ab-83d2-661975830a7d";

// The worker's clock, a second after the release was asked for.
const NOW = REQUESTED_AT + 1000;

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

// Lambda's context, with this much of the worker's time left.
function contextWith(remainingMs: number) {
  return { getRemainingTimeInMillis: () => remainingMs };
}

function handlerWith(aws: ReleaseAws, table: FakeTable) {
  const handler = createReleaseHandler({
    config: CONFIG,
    aws,
    table,
    now: () => NOW,
  });
  return (sqsEvent: SqsEvent) => handler(sqsEvent, contextWith(14 * 60_000));
}

const ASKED = {
  releaseId: RELEASE_ID,
  environment: "development",
  domain: "example",
  sha256: SHA256,
  runId: "12345678901",
  commit: COMMIT,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createReleaseHandler", () => {
  it("releases what the table records, records how it went, and logs it", async () => {
    const logs = captureLogs();
    const lambda = new FakeLambda();
    const table = new FakeTable(queuedRecord());

    const response = await handlerWith(
      fakeAws(lambda).aws,
      table,
    )(event(messageFor()));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(lambda.alias).toEqual({
      version: "1",
      revisionId: "revision-1",
      releaseId: RELEASE_ID,
    });
    expect(table.record).toEqual(
      queuedRecord({
        status: "released",
        attempts: 1,
        updatedAt: NOW,
        version: "1",
        created: true,
        moved: true,
      }),
    );
    expect(logs).toEqual([
      {
        level: "INFO",
        message: "telemetry",
        telemetry: {
          event: "release_done",
          details: {
            messageId: MESSAGE_ID,
            durationMs: 0,
            ...ASKED,
            version: "1",
            created: true,
            moved: true,
          },
        },
      },
    ]);
  });

  it("gives the release's waits what is left of the worker's time, less the time to record how it went", async () => {
    captureLogs();
    const { aws, timeLimits } = fakeAws(new FakeLambda());
    const handler = createReleaseHandler({
      config: CONFIG,
      aws,
      table: new FakeTable(queuedRecord()),
      now: () => NOW,
    });

    await handler(event(messageFor()), contextWith(600_000));

    expect(timeLimits.map((timeLeft) => timeLeft())).toEqual([570_000]);
  });

  // Anything IAM lets invoke the function can write its event. Only the API records a release.
  it("acts on nothing for a release the table doesn't hold", async () => {
    const logs = captureLogs();
    const lambda = new FakeLambda();
    const { aws, assumed, read } = fakeAws(lambda);

    const response = await handlerWith(
      aws,
      new FakeTable(),
    )(event(messageFor()));

    expect(response).toEqual({ batchItemFailures: [] });
    expect([...assumed, ...read, ...lambda.calls]).toEqual([]);
    expect(logs).toEqual([
      {
        level: "ERROR",
        message: "telemetry",
        telemetry: {
          event: "release_unknown",
          details: { messageId: MESSAGE_ID, durationMs: 0 },
        },
      },
    ]);
  });

  it("releases what the table says, whatever else the message holds", async () => {
    captureLogs();
    const lambda = new FakeLambda();
    const { aws, read } = fakeAws(lambda);
    const body = JSON.stringify({
      ...JSON.parse(messageFor()),
      sha256: "0".repeat(64),
    });

    await handlerWith(aws, new FakeTable(queuedRecord()))(event(body));

    expect(read).toEqual([]);
  });

  // A message sent again, however it was got, runs nothing a second time.
  it.each<[string, Parameters<typeof queuedRecord>[0]]>([
    ["released", { status: "released", version: "1" }],
    ["refused", { status: "refused", reason: "bundle-hash" }],
  ])(
    "runs nothing for a release that is %s, and lets it go",
    async (_, state) => {
      const logs = captureLogs();
      const lambda = new FakeLambda();
      const { aws, assumed } = fakeAws(lambda);
      const table = new FakeTable(queuedRecord(state));

      const response = await handlerWith(aws, table)(event(messageFor()));

      expect(response).toEqual({ batchItemFailures: [] });
      expect(assumed).toEqual([]);
      expect(table.record).toEqual(queuedRecord(state));
      expect(logs).toEqual([
        expect.objectContaining({
          telemetry: {
            event: "release_not_claimed",
            details: expect.objectContaining({
              releaseId: RELEASE_ID,
              status: state?.status,
            }) as unknown,
          },
        }),
      ]);
    },
  );

  it.each<[string, Parameters<typeof queuedRecord>[0]]>([
    ["failed", { status: "failed", step: "update-code", reason: "x" }],
    // An attempt that stopped with its function, or one still running: either way Lambda says
    // what is done.
    ["releasing", { status: "releasing" }],
    // Anything that can invoke the dead-letter worker could have it give up a release the queue
    // still holds.
    ["abandoned", { status: "abandoned", reason: "EniLimitExceeded" }],
  ])("tries a release again that is %s", async (_, state) => {
    captureLogs();
    const lambda = new FakeLambda();
    const table = new FakeTable(queuedRecord({ ...state, attempts: 1 }));

    await handlerWith(fakeAws(lambda).aws, table)(event(messageFor()));

    expect(table.record).toMatchObject({ status: "released", attempts: 2 });
    expect(table.record).not.toHaveProperty("step");
  });

  it("records a release live already names as released, changing nothing in Lambda", async () => {
    captureLogs();
    const lambda = new FakeLambda({
      versions: ["1"],
      alias: { version: "1", revisionId: "revision-1", releaseId: RELEASE_ID },
    });
    const table = new FakeTable(
      queuedRecord({ status: "releasing", attempts: 1 }),
    );

    const response = await handlerWith(
      fakeAws(lambda).aws,
      table,
    )(event(messageFor()));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(lambda.calls).toEqual(["getAlias"]);
    expect(table.record).toMatchObject({
      status: "released",
      version: "1",
      moved: false,
    });
  });

  // Recorded first, then given back, so the next delivery finds the release as it was left.
  it("gives the message back when another writer recorded the release since the claim", async () => {
    const logs = captureLogs();
    const table = new FakeTable(queuedRecord());
    const finish = table.finish.bind(table);
    table.finish = (key, outcome, now, from) => {
      table.records.set(
        `development/example/${RELEASE_ID}`,
        queuedRecord({ status: "released", version: "9" }),
      );
      return finish(
        key,
        { ...outcome, status: "failed", reason: "x" },
        now,
        from,
      );
    };

    const response = await handlerWith(
      fakeAws(new FakeLambda()).aws,
      table,
    )(event(messageFor()));

    expect(response).toEqual({
      batchItemFailures: [{ itemIdentifier: MESSAGE_ID }],
    });
    expect(table.record).toMatchObject({ status: "released", version: "9" });
    expect(logs).toContainEqual(
      expect.objectContaining({
        telemetry: expect.objectContaining({
          event: "release_failed",
          details: expect.objectContaining({
            step: "record-outcome",
          }) as unknown,
        }) as unknown,
      }),
    );
  });

  it("gives a release that failed back to the queue, recording the step and AWS's code for why", async () => {
    const logs = captureLogs();
    const lambda = new FakeLambda();
    lambda.failures.set(
      "createFunction",
      awsError("TooManyRequestsException", "SYNTHETIC request text"),
    );
    const table = new FakeTable(queuedRecord());

    const response = await handlerWith(
      fakeAws(lambda).aws,
      table,
    )(event(messageFor()));

    expect(response).toEqual({
      batchItemFailures: [{ itemIdentifier: MESSAGE_ID }],
    });
    expect(table.record).toMatchObject({
      status: "failed",
      step: "create-function",
      reason: "TooManyRequestsException",
    });
    expect(logs).toEqual([
      expect.objectContaining({
        level: "ERROR",
        telemetry: {
          event: "release_failed",
          details: expect.objectContaining({
            step: "create-function",
            reason: "TooManyRequestsException",
            frames: expect.any(Array) as unknown,
          }) as unknown,
        },
      }),
    ]);
    expect(JSON.stringify(logs)).not.toContain("SYNTHETIC");
  });

  it("lets go of a release that can never succeed, recording it refused", async () => {
    const logs = captureLogs();
    const table = new FakeTable(queuedRecord());

    const response = await handlerWith(
      fakeAws(new FakeLambda(), { held: "0".repeat(64) }).aws,
      table,
    )(event(messageFor()));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(table.record).toMatchObject({
      status: "refused",
      step: "check-bundle",
      reason: "bundle-hash",
    });
    expect(logs).toEqual([
      expect.objectContaining({
        telemetry: expect.objectContaining({
          event: "release_refused",
        }) as unknown,
      }),
    ]);
  });

  it("refuses a release asked for before the one on live", async () => {
    captureLogs();
    const lambda = new FakeLambda({
      versions: ["1"],
      alias: {
        version: "1",
        revisionId: "revision-1",
        releaseId: releaseIdAt(1),
      },
    });
    const table = new FakeTable(queuedRecord());

    await handlerWith(fakeAws(lambda).aws, table)(event(messageFor()));

    expect(table.record).toMatchObject({
      status: "refused",
      step: "check-order",
      reason: "superseded",
    });
  });

  it("records an unexpected failure with no step", async () => {
    captureLogs();
    const { aws } = fakeAws(new FakeLambda());
    aws.deployAs = () => {
      throw new TypeError("SYNTHETIC");
    };
    const table = new FakeTable(queuedRecord());

    await handlerWith(aws, table)(event(messageFor()));

    expect(table.record).toMatchObject({
      status: "failed",
      reason: "unexpected",
    });
    expect(table.record).not.toHaveProperty("step");
  });

  it("refuses a release for a domain the config holds no target for", async () => {
    const logs = captureLogs();
    const record = queuedRecord({ domain: "elsewhere" });
    const table = new FakeTable(record);
    const lambda = new FakeLambda();

    const response = await handlerWith(
      fakeAws(lambda).aws,
      table,
    )(event(messageFor(record)));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(lambda.calls).toEqual([]);
    expect(
      table.records.get(`development/elsewhere/${RELEASE_ID}`),
    ).toMatchObject({ status: "refused", reason: "unknown-target" });
    expect(logs).toEqual([
      expect.objectContaining({
        telemetry: expect.objectContaining({
          event: "release_unknown_target",
        }) as unknown,
      }),
    ]);
  });

  it.each(["get", "claim", "finish"])(
    "gives the message back when the table fails to %s",
    async (call) => {
      const logs = captureLogs();
      const table = new FakeTable(queuedRecord());
      table.failures.set(
        call,
        awsError("ProvisionedThroughputExceededException"),
      );

      const response = await handlerWith(
        fakeAws(new FakeLambda()).aws,
        table,
      )(event(messageFor()));

      expect(response).toEqual({
        batchItemFailures: [{ itemIdentifier: MESSAGE_ID }],
      });
      expect(logs).toContainEqual(
        expect.objectContaining({
          telemetry: {
            event: "release_failed",
            details: expect.objectContaining({
              reason: "ProvisionedThroughputExceededException",
            }) as unknown,
          },
        }),
      );
    },
  );

  it.each<[string, string]>([
    ["a message that names no release", "SYNTHETIC text"],
    ["a message that holds a request", JSON.stringify(REQUEST)],
  ])("lets go of %s, naming nothing from it", async (_, body) => {
    const logs = captureLogs();

    const response = await handlerWith(
      fakeAws(new FakeLambda()).aws,
      new FakeTable(),
    )(event(body));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(logs).toEqual([
      {
        level: "ERROR",
        message: "telemetry",
        telemetry: {
          event: "release_invalid",
          details: { messageId: MESSAGE_ID, durationMs: 0 },
        },
      },
    ]);
  });
});
