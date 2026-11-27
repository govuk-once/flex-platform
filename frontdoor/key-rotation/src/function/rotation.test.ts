import { assert, describe, expect, it } from "vitest";

import { MemoryPorts } from "../../test/ports.ts";
import { CALLER_TOKEN_POLICY } from "./policy.ts";
import { revoke } from "./revoke.ts";
import {
  KeyCheckFailed,
  rotate as rotateKeys,
  type RotationPorts,
} from "./rotation.ts";

const {
  periodMs: ROTATION_PERIOD_MS,
  minimumLeadMs: MINIMUM_LEAD_MS,
  retiredKeptMs: RETIRED_KEPT_MS,
} = CALLER_TOKEN_POLICY;

// The caller token's keys, whose behaviour these tests hold to what its page documents.
const rotate = (ports: RotationPorts, now: Date) =>
  rotateKeys(ports, CALLER_TOKEN_POLICY, now);

const START = new Date("2026-11-06T12:00:00Z");
const after = (ms: number, from: Date = START) => new Date(from.getTime() + ms);
const seconds = (at: Date) => Math.floor(at.getTime() / 1000);
const MINUTE = 60_000;

const FIRST = "20261106T120000Z";
const NEXT = "20261106T121500Z";
const SWITCH = after(ROTATION_PERIOD_MS);

// Two runs: the first makes a key, the second schedules the next.
async function rotated(): Promise<MemoryPorts> {
  const ports = new MemoryPorts();
  await rotate(ports, START);
  await rotate(ports, after(15 * MINUTE));
  return ports;
}

describe("rotate", () => {
  it("makes a key that signs at once, in one transaction", async () => {
    const ports = new MemoryPorts();
    const report = await rotate(ports, START);

    expect(report.events).toEqual([
      { event: "key_generated", keyId: FIRST, activeFrom: seconds(START) },
    ]);
    expect(ports.signingKid(START)).toBe(FIRST);
    expect(ports.calls).toEqual([
      `generate ${FIRST}`,
      `check ${FIRST}`,
      "commit",
    ]);
  });

  it("schedules the next key a period after the last started, and gives it to the edge now", async () => {
    const ports = await rotated();

    expect(ports.edgeKids(after(15 * MINUTE))).toEqual([FIRST, NEXT]);
    expect(ports.signingKid(after(15 * MINUTE))).toBe(FIRST);
    expect(ports.publicKeys()).toEqual([
      {
        keyId: FIRST,
        activeFrom: seconds(START),
        activeUntil: seconds(SWITCH),
      },
      { keyId: NEXT, activeFrom: seconds(SWITCH) },
    ]);
  });

  it("does nothing when nothing is due, and changes no table", async () => {
    const ports = await rotated();
    const { version } = ports.state;
    const report = await rotate(ports, after(30 * MINUTE));

    expect(report.events).toEqual([]);
    expect(ports.state.version).toBe(version);
  });

  it("switches every edge at the scheduled moment, with no run between", async () => {
    const ports = await rotated();

    expect(ports.signingKid(after(-1000, SWITCH))).toBe(FIRST);
    expect(ports.signingKid(SWITCH)).toBe(NEXT);
  });

  it("takes the old key from the edge after the switch, and from the tables and the gateways once no token it signed lives", async () => {
    const ports = await rotated();

    const run = await rotate(ports, after(MINUTE, SWITCH));
    expect(run.events.map(({ event }) => event)).toEqual(["key_generated"]);
    expect(ports.edgeKids(after(MINUTE, SWITCH))).toEqual([
      NEXT,
      "20261113T120100Z",
    ]);
    expect(ports.publicKids()).toContain(FIRST);

    const pruned = await rotate(ports, after(RETIRED_KEPT_MS, SWITCH));
    expect(pruned.events).toEqual([{ event: "key_pruned", keyId: FIRST }]);
    expect(ports.publicKids()).not.toContain(FIRST);
    expect(ports.state.keys.map(({ keyId }) => keyId)).not.toContain(FIRST);
  });

  it("schedules the next key the least lead ahead when the runs stopped for longer than a period", async () => {
    const ports = new MemoryPorts();
    await rotate(ports, START);
    const late = after(ROTATION_PERIOD_MS * 2);
    const report = await rotate(ports, late);

    expect(report.events).toEqual([
      {
        event: "key_generated",
        keyId: "20261120T120000Z",
        activeFrom: seconds(after(MINIMUM_LEAD_MS, late)),
      },
    ]);
    expect(ports.signingKid(late)).toBe(FIRST);
  });

  it("checks every key the edge is to hold on every run, and none that has stopped", async () => {
    const ports = await rotated();
    await rotate(ports, after(MINUTE, SWITCH));
    ports.calls.length = 0;

    await rotate(ports, after(2 * MINUTE, SWITCH));
    expect(ports.calls).toEqual([`check ${NEXT}`, "check 20261113T120100Z"]);
  });

  it("keeps no key it made that KMS can't decrypt, and makes another on the next run", async () => {
    const ports = new MemoryPorts();
    await rotate(ports, START);
    ports.undecryptable = NEXT;

    const error = await rotate(ports, after(15 * MINUTE)).catch(
      (thrown: unknown) => thrown,
    );
    assert.instanceOf(error, KeyCheckFailed);
    expect(error).toMatchObject({
      keyId: NEXT,
      reason: "InvalidCiphertextException",
      stored: false,
    });
    expect(ports.state.keys.map(({ keyId }) => keyId)).toEqual([FIRST]);
    expect(ports.publicKids()).toEqual([FIRST]);

    await rotate(ports, after(30 * MINUTE));
    expect(ports.edgeKids(after(30 * MINUTE))).toEqual([
      FIRST,
      "20261106T123000Z",
    ]);
  });

  it("stops at a kept key KMS can't decrypt, writing nothing, until it is revoked", async () => {
    const ports = await rotated();
    ports.undecryptable = NEXT;
    ports.calls.length = 0;

    const error = await rotate(ports, after(30 * MINUTE)).catch(
      (thrown: unknown) => thrown,
    );
    assert.instanceOf(error, KeyCheckFailed);
    expect(error).toMatchObject({ keyId: NEXT, stored: true });
    expect(ports.calls).toEqual([`check ${FIRST}`, `check ${NEXT}`]);

    await revoke(ports, after(45 * MINUTE), NEXT);
    await rotate(ports, after(45 * MINUTE));
    expect(ports.edgeKids(after(45 * MINUTE))).toEqual([
      FIRST,
      "20261106T124500Z",
    ]);
  });

  it("writes nothing to the tables when the transaction fails, and makes the change on the next run", async () => {
    const ports = new MemoryPorts();
    await rotate(ports, START);
    const before = ports.state;
    ports.failCommit = true;

    await expect(rotate(ports, after(15 * MINUTE))).rejects.toThrow(
      "DynamoDB refused the transaction",
    );
    expect(ports.state).toBe(before);
    expect(ports.calls.at(-1)).toBe("commit");

    ports.failCommit = false;
    const retried = await rotate(ports, after(30 * MINUTE));
    expect(retried.events.map(({ event }) => event)).toEqual(["key_generated"]);
    expect(ports.edgeKids(after(30 * MINUTE))).toEqual([
      FIRST,
      "20261106T123000Z",
    ]);
    // The key the failed run made was never held.
    expect(ports.publicKids()).toEqual([FIRST, "20261106T123000Z"]);
  });
});
