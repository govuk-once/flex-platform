import { describe, expect, it } from "vitest";

import { createLogger } from "./logger.ts";
import { REDACTED } from "./redact.ts";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const sink = {
    write(line: string) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
  return { lines, sink };
}

describe("createLogger", () => {
  it("writes the level by name, the domain's name and the fields, with no process details", () => {
    const { lines, sink } = capture();
    createLogger("todos", {}, sink).info("todo read", { id: "1" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "info",
      name: "todos",
      msg: "todo read",
      id: "1",
    });
    expect(lines[0]).not.toHaveProperty("pid");
    expect(lines[0]).not.toHaveProperty("hostname");
  });

  it("writes nothing below the level set", () => {
    const { lines, sink } = capture();
    const log = createLogger("todos", { level: "warn" }, sink);
    log.info("quiet");
    log.warn("loud");
    expect(lines.map((line) => line["msg"])).toEqual(["loud"]);
  });

  it("redacts the fields and the message, at any depth, with the domain's patterns too", () => {
    const { lines, sink } = capture();
    const log = createLogger("todos", { redactValues: [/^CLM-\d+$/] }, sink);
    log.child({ requestId: "r-1" }).info("mail to someone@example.com", {
      apiKey: "SYNTHETIC_API_KEY",
      deep: { list: [{ email: "x" }, "CLM-1"] },
      kept: "yes",
    });
    expect(JSON.stringify(lines)).not.toContain("SYNTHETIC_API_KEY");
    expect(JSON.stringify(lines)).not.toContain("example.com");
    expect(lines[0]).toMatchObject({
      msg: REDACTED,
      requestId: "r-1",
      apiKey: REDACTED,
      deep: { list: [{ email: REDACTED }, REDACTED] },
      kept: "yes",
    });
  });

  it("redacts the fields a child logger carries", () => {
    const { lines, sink } = capture();
    const log = createLogger("todos", {}, sink);
    log
      .child({
        correlationId: "someone@example.com",
        apiKey: "SYNTHETIC_API_KEY",
        requestId: "r-1",
      })
      .child({ deep: { surname: "x" } })
      .info("read");
    expect(JSON.stringify(lines)).not.toContain("SYNTHETIC_API_KEY");
    expect(JSON.stringify(lines)).not.toContain("example.com");
    expect(lines[0]).toMatchObject({
      correlationId: REDACTED,
      apiKey: REDACTED,
      requestId: "r-1",
      deep: { surname: REDACTED },
    });
  });

  it("reduces an error to where it was created", () => {
    const { lines, sink } = capture();
    const error = new Error("a message holding SYNTHETIC_API_KEY");
    const other = new Error("a message holding SYNTHETIC_API_KEY");
    createLogger("todos", {}, sink)
      .child({ error: other })
      .error("failed", { err: error, nested: { cause: error } });
    const line = JSON.stringify(lines[0]);
    expect(line).not.toContain("SYNTHETIC_API_KEY");
    expect(line).not.toContain("a message");
    const here = expect.stringContaining("logger.test.ts") as unknown;
    expect(lines[0]).toMatchObject({
      err: { frames: expect.arrayContaining([here]) as unknown },
      error: { frames: expect.arrayContaining([here]) as unknown },
      nested: { cause: { frames: expect.arrayContaining([here]) as unknown } },
    });
  });

  it("reduces whatever else is logged as an error to nothing", () => {
    const { lines, sink } = capture();
    createLogger("todos", {}, sink).error("failed", {
      err: "thrown text",
      error: { message: "thrown text" },
    });
    expect(JSON.stringify(lines)).not.toContain("thrown text");
    expect(lines[0]).toMatchObject({
      err: { frames: [] },
      error: { frames: [] },
    });
  });
});
