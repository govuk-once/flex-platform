import { describe, expect, it } from "vitest";

import type { LogEntry, LogLevel } from "./log-writer.ts";
import {
  CALLER_VALUE_REPLACEMENT,
  callerValueGuard,
  handlerLog,
  pinoSink,
} from "./log-writer.ts";

interface Written {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogEntry;
}

function capture() {
  const written: Written[] = [];

  return {
    written,
    sink: {
      write: (level: LogLevel, message: string, fields: LogEntry) => {
        written.push({ level, message, fields });
      },
    },
  };
}

describe("pinoSink", () => {
  it("writes each entry as one JSON line, with the domain's name, the level and the message", () => {
    const lines: string[] = [];

    pinoSink("domain-a", { write: (line) => lines.push(line) }).write(
      "warn",
      "request refused",
      { route: "POST /v1/todos", status: 400 },
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\n$/);
    const { time, hostname, ...line } = JSON.parse(lines[0] ?? "") as Record<
      string,
      unknown
    >;

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

  it.each<[LogLevel, number]>([
    ["info", 30],
    ["warn", 40],
    ["error", 50],
  ])("writes %s as level %i", (level, number) => {
    const lines: string[] = [];

    pinoSink("domain-a", { write: (line) => lines.push(line) }).write(
      level,
      "request answered",
      {},
    );

    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: number });
  });
});

describe("callerValueGuard", () => {
  const guard = callerValueGuard(["token.value.sig", "user-a", "push-a"]);

  it("replaces any text that holds a caller value, wherever it is, and says where", () => {
    expect(
      guard({
        route: "GET /v1/todos",
        input: { "body.note": "from user-a", "items.*.id": ["1", "push-a"] },
        fields: { header: "Bearer token.value.sig" },
      }),
    ).toEqual({
      fields: {
        route: "GET /v1/todos",
        input: {
          "body.note": CALLER_VALUE_REPLACEMENT,
          "items.*.id": ["1", CALLER_VALUE_REPLACEMENT],
        },
        fields: { header: CALLER_VALUE_REPLACEMENT },
      },
      replaced: ["input.body.note", "input.items.*.id[1]", "fields.header"],
    });
  });

  it("leaves everything else as it is", () => {
    const fields = { status: 200, input: { "query.page": 2, done: true } };

    expect(guard(fields)).toEqual({ fields, replaced: [] });
  });
});

describe("handlerLog", () => {
  const context = {
    traceId: "1-5759e988-bd862e3fe1be46a994272793",
    route: "GET /v1/todos",
  };

  it("writes the handler's message and scalar fields under their own key, with the request's context", () => {
    const { written, sink } = capture();

    const log = handlerLog(sink, context, callerValueGuard(["user-a"]));

    log.info("todo not found", { attempt: 2, cached: false, etag: null });
    log.warn("retrying", { nested: { a: 1 } } as never);

    expect(written).toEqual([
      {
        level: "info",
        message: "todo not found",
        fields: {
          ...context,
          fields: { attempt: 2, cached: false, etag: null },
        },
      },
      { level: "warn", message: "retrying", fields: context },
    ]);
  });

  it("replaces a caller value in a field or the message, and raises the line to a warning", () => {
    const { written, sink } = capture();

    const log = handlerLog(sink, context, callerValueGuard(["user-a"]));

    log.info("seen" as never, { who: "user-a" });
    log.info("user-a" as never);

    expect(written).toEqual([
      {
        level: "warn",
        message: "seen",
        fields: {
          ...context,
          fields: { who: CALLER_VALUE_REPLACEMENT },
          replaced: ["fields.who"],
        },
      },
      {
        level: "warn",
        message: CALLER_VALUE_REPLACEMENT,
        fields: { ...context, replaced: ["msg"] },
      },
    ]);
  });
});
