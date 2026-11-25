import { isRecord } from "@repo/utils/is-record";
import { describe, expect, it } from "vitest";

import {
  createLogger,
  createRequestLogger,
  REDACTED,
  requestFields,
  withCallerValues,
} from "./logging.ts";

const TRACE_ID = "1-5759e988-bd862e3fe1be46a994272793";

const ROUTE = "GET /v1/todos";

function capture() {
  const lines: Record<string, unknown>[] = [];

  const logger = createLogger("domain-a", {
    write: (line: string) => {
      const parsed: unknown = JSON.parse(line);

      if (isRecord(parsed)) lines.push(parsed);
    },
  });

  return { lines, logger };
}

describe("createLogger", () => {
  it("writes one JSON line in the gateways' format, under the domain's name", () => {
    const { lines, logger } = capture();

    logger.warn({ route: "POST /v1/todos", status: 400 }, "request refused");

    const [{ time, hostname, ...line } = {}] = lines;

    expect(typeof time).toBe("number");
    expect(typeof hostname).toBe("string");
    expect(line).toEqual({
      level: 40,
      pid: process.pid,
      name: "domain-a",
      route: "POST /v1/todos",
      status: 400,
      msg: "request refused",
    });
  });
});

describe("requestFields", () => {
  it("holds the trace ID and route the request has", () => {
    expect(requestFields(TRACE_ID, ROUTE)).toEqual({
      traceId: TRACE_ID,
      route: ROUTE,
    });
    expect(requestFields(undefined, ROUTE)).toEqual({ route: ROUTE });
    expect(requestFields(undefined, undefined)).toEqual({});
  });
});

describe("createRequestLogger", () => {
  it("writes what it is given, with the request's fields", () => {
    const { lines, logger } = capture();

    const log = createRequestLogger(logger, requestFields(TRACE_ID, ROUTE));

    log.info("todo not found");
    log.error({ todo: { id: "1" }, pairwiseId: "user-a" }, "todo invalid");

    expect(lines).toMatchObject([
      { level: 30, msg: "todo not found", traceId: TRACE_ID, route: ROUTE },
      {
        level: 50,
        msg: "todo invalid",
        traceId: TRACE_ID,
        route: ROUTE,
        todo: { id: "1" },
        pairwiseId: "user-a",
      },
    ]);
  });

  it("drops the request's fields a handler writes, in a line or its bindings", () => {
    const { lines, logger } = capture();

    const log = createRequestLogger(logger, requestFields(undefined, ROUTE));

    log.info({ traceId: "other", route: "other", attempt: 2 }, "retrying");
    log.setBindings({ traceId: "other", region: "a" });
    log.info("bound");

    expect(lines).toEqual([
      expect.objectContaining({ route: ROUTE, attempt: 2, msg: "retrying" }),
      expect.objectContaining({ route: ROUTE, region: "a", msg: "bound" }),
    ]);
    expect(lines[0]).not.toHaveProperty("traceId");
    expect(lines[1]).not.toHaveProperty("traceId");
  });

  it("writes the request's fields after a child's own", () => {
    const written: string[] = [];

    const logger = createLogger("domain-a", {
      write: (line: string) => written.push(line),
    });

    createRequestLogger(logger, requestFields(TRACE_ID, ROUTE))
      .child({ route: "other" })
      .info("from a child");

    const [line = ""] = written;

    expect(line.lastIndexOf(`"route":"${ROUTE}"`)).toBeGreaterThan(
      line.indexOf('"route":"other"'),
    );
    expect(JSON.parse(line)).toMatchObject({ traceId: TRACE_ID, route: ROUTE });
  });
});

describe("withCallerValues", () => {
  const HELD = ["token.value.sig", "user-a", 'push"a'];

  it("replaces any text holding a value, in a line's message, fields, keys and bindings", async () => {
    const { lines, logger } = capture();

    const log = createRequestLogger(logger, requestFields(TRACE_ID, ROUTE));

    await withCallerValues(HELD, async () => {
      log.info({ note: "for user-a", ids: ["1", 'push"a'] }, "seen");
      log.warn("token %s", "Bearer token.value.sig");
      log.child({ who: "user-a" }).info({ "user-a": 1 }, "bound");

      await Promise.resolve();

      log.info({ later: "user-a" }, "after an await");
    });

    expect(lines).toMatchObject([
      { msg: "seen", note: REDACTED, ids: ["1", REDACTED], route: ROUTE },
      { msg: REDACTED },
      { msg: "bound", who: REDACTED, [REDACTED]: 1 },
      { msg: "after an await", later: REDACTED },
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/user-a|token\.value|push/);
  });

  it("leaves a line alone where no value appears, and outside the run", () => {
    const { lines, logger } = capture();

    withCallerValues(HELD, () => {
      logger.info({ count: 1 }, "nothing held");
    });

    logger.info({ who: "user-a" }, "outside");

    expect(lines).toMatchObject([
      { msg: "nothing held", count: 1 },
      { msg: "outside", who: "user-a" },
    ]);
  });
});
