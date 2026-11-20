import { describe, expect, it, vi } from "vitest";

import { domain } from "./config.ts";
import { log } from "./logging/log.ts";
import type * as loggerModule from "./logging/logger.ts";
import { REDACTED } from "./logging/redact.ts";

const lines = vi.hoisted((): Record<string, unknown>[] => []);

// The domain's logger as it is, written to the test instead of stdout.
vi.mock("./logging/logger.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof loggerModule>();
  const sink = {
    write(line: string) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
  const createLogger: typeof actual.createLogger = (name, options) =>
    actual.createLogger(name, options, sink);
  return { ...actual, createLogger };
});

describe("domain", () => {
  it("makes its logger the one log writes to outside a request", () => {
    domain({
      name: "claims",
      common: { logging: { level: "debug", redactKeys: [/^claimRef$/] } },
      routes: {},
    });
    log.debug("loaded", { claimRef: "CLM-1", kept: "yes" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "debug",
      name: "claims",
      msg: "loaded",
      claimRef: REDACTED,
      kept: "yes",
    });
  });
});
