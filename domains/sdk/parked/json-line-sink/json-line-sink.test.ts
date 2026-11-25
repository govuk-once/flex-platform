import pino from "pino";
import { describe, expect, it } from "vitest";

import type { LogLevel } from "../../src/runtime/log-writer.ts";
import { jsonLineSink } from "./json-line-sink.ts";

const TIME = 1_795_862_400_000;

describe("jsonLineSink", () => {
  it("writes the line Pino writes for the same entry", () => {
    const fields = {
      traceId: "1-5759e988-bd862e3fe1be46a994272793",
      route: "POST /v1/todos",
      status: 400,
      part: "body",
      input: { "query.page": 2 },
    };

    const ours: string[] = [];

    jsonLineSink("domain-a", {
      write: (line) => ours.push(line),
      now: () => TIME,
    }).write("warn", "request refused", fields);

    const theirs: string[] = [];

    pino(
      { name: "domain-a", timestamp: () => `,"time":${TIME}` },
      { write: (line: string) => theirs.push(line) },
    ).warn(fields, "request refused");

    expect(ours).toEqual(theirs);
  });

  it.each<[LogLevel, number]>([
    ["info", 30],
    ["warn", 40],
    ["error", 50],
  ])("writes %s as Pino's level %i", (level, number) => {
    const lines: string[] = [];

    jsonLineSink("domain-a", { write: (line) => lines.push(line) }).write(
      level,
      "request answered",
      {},
    );

    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: number });
  });
});
