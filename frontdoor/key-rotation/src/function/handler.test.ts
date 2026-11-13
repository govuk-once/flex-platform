import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryPorts } from "../../test/ports.ts";
import { createHandler } from "./handler.ts";

const NOW = new Date("2026-11-06T12:00:00Z");

function captureLogs(): unknown[] {
  const lines: unknown[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(JSON.parse(line));
  });
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createHandler", () => {
  it("runs rotation for the schedule's event, logging what it did by key ID alone", async () => {
    const lines = captureLogs();
    const ports = new MemoryPorts();
    await createHandler(ports, () => NOW)({ source: "aws.events" });

    expect(lines).toContainEqual({
      level: "INFO",
      message: "telemetry",
      telemetry: {
        event: "key_generated",
        details: {
          kid: "20261106T120000Z",
          signsFrom: NOW.getTime() / 1000,
        },
      },
    });
    expect(JSON.stringify(lines)).not.toContain(
      ports.state.keys[0]?.privateKey,
    );
  });

  it("revokes the key a person names", async () => {
    const ports = new MemoryPorts();
    await createHandler(ports, () => NOW)({});
    captureLogs();
    await createHandler(
      ports,
      () => new Date("2026-11-06T13:00:00Z"),
    )({
      revoke: "20261106T120000Z",
    });

    expect(ports.publishedKids()).not.toContain("20261106T120000Z");
  });

  it("logs a key that fails its check by its ID, AWS's name for the error, and whether it was held", async () => {
    const ports = new MemoryPorts();
    await createHandler(ports, () => NOW)({});
    const lines = captureLogs();
    ports.undecryptable = "20261106T120000Z";

    await expect(
      createHandler(ports, () => new Date("2026-11-06T12:15:00Z"))({}),
    ).rejects.toThrow("failed its check");
    expect(lines).toEqual([
      {
        level: "ERROR",
        message: "telemetry",
        telemetry: {
          event: "key_check_failed",
          details: {
            kid: "20261106T120000Z",
            reason: "InvalidCiphertextException",
            stored: true,
          },
        },
      },
    ]);
  });

  it("refuses a revocation that names no key ID", async () => {
    const lines = captureLogs();
    await expect(
      createHandler(new MemoryPorts(), () => NOW)({ revoke: "../everything" }),
    ).rejects.toThrow("revoke must name a key ID");
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: "ERROR",
        telemetry: expect.objectContaining({
          event: "key_rotation_failed",
        }) as unknown,
      }),
    );
  });
});
