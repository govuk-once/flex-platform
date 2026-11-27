import { afterEach, assert, describe, expect, it, vi } from "vitest";

import { MemoryPorts } from "../../test/ports.ts";
import { createHandler as createKindHandler } from "./handler.ts";
import { CALLER_TOKEN_POLICY } from "./policy.ts";
import type { RotationPorts } from "./rotation.ts";

const createHandler = (ports: RotationPorts, now: () => Date) =>
  createKindHandler(ports, CALLER_TOKEN_POLICY, now);

const NOW = new Date("2026-11-06T12:00:00Z");

function captureLogs(): unknown[] {
  const lines: unknown[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(JSON.parse(line));
  });
  return lines;
}

const telemetry = (level: string, event: string, details: unknown) => ({
  level,
  message: "telemetry",
  telemetry: { event, details },
});

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
          keyId: "20261106T120000Z",
          activeFrom: NOW.getTime() / 1000,
        },
      },
    });
    const privateKey = ports.state.keys[0]?.privateKey;
    assert(privateKey !== undefined);
    expect(JSON.stringify(lines)).not.toContain(
      Buffer.from(privateKey).toString("base64"),
    );
    expect(JSON.stringify(lines)).not.toContain("private ");
  });

  it("revokes the key a person names, logs it, then runs rotation", async () => {
    const ports = new MemoryPorts();
    await createHandler(ports, () => NOW)({});
    const lines = captureLogs();
    const at = new Date("2026-11-06T13:00:00Z");
    await createHandler(ports, () => at)({ revoke: "20261106T120000Z" });

    expect(ports.publicKids()).toEqual(["20261106T130000Z"]);
    expect(lines).toEqual([
      telemetry("INFO", "key_revoked", { keyId: "20261106T120000Z" }),
      telemetry("INFO", "key_generated", {
        keyId: "20261106T130000Z",
        activeFrom: at.getTime() / 1000,
      }),
    ]);
  });

  it("has revoked the key, and logged it, when the rest of the run fails", async () => {
    const ports = new MemoryPorts();
    await createHandler(ports, () => NOW)({});
    const lines = captureLogs();
    ports.kmsDisabled = true;

    await expect(
      createHandler(
        ports,
        () => new Date("2026-11-06T13:00:00Z"),
      )({ revoke: "20261106T120000Z" }),
    ).rejects.toThrow("The KMS key is disabled");
    expect(ports.publicKids()).toEqual([]);
    expect(lines).toEqual([
      telemetry("INFO", "key_revoked", { keyId: "20261106T120000Z" }),
      telemetry(
        "ERROR",
        "key_rotation_failed",
        expect.objectContaining({ name: "DisabledException" }),
      ),
    ]);
  });

  it("answers a revocation run again as already revoked, and still runs rotation", async () => {
    const ports = new MemoryPorts();
    await createHandler(ports, () => NOW)({});
    const revokeAt = (at: string) =>
      createHandler(ports, () => new Date(at))({ revoke: "20261106T120000Z" });
    await revokeAt("2026-11-06T13:00:00Z");
    const lines = captureLogs();

    await revokeAt("2026-11-06T13:15:00Z");
    expect(lines).toEqual([
      telemetry("INFO", "key_already_revoked", { keyId: "20261106T120000Z" }),
      telemetry(
        "INFO",
        "key_generated",
        expect.objectContaining({ keyId: "20261106T131500Z" }),
      ),
    ]);
  });

  it("fails for a key ID rotation neither holds nor has revoked, changing nothing", async () => {
    const ports = new MemoryPorts();
    await createHandler(ports, () => NOW)({});
    const before = ports.state;
    const lines = captureLogs();

    await expect(
      createHandler(
        ports,
        () => new Date("2026-11-06T13:00:00Z"),
      )({ revoke: "20991231T000000Z" }),
    ).rejects.toThrow("The key to revoke is not one rotation holds");
    expect(ports.state).toBe(before);
    expect(lines).toEqual([
      telemetry("ERROR", "key_rotation_failed", expect.anything()),
    ]);
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
            keyId: "20261106T120000Z",
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
