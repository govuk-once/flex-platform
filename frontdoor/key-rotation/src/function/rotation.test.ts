import { assert, describe, expect, it } from "vitest";

import { MemoryPorts } from "../../test/ports.ts";
import { CALLER_TOKEN_POLICY } from "./policy.ts";
import {
  KeyCheckFailed,
  rotate as rotateKeys,
  type RotationPorts,
  type RotationRequest,
} from "./rotation.ts";

const {
  periodMs: ROTATION_PERIOD_MS,
  minimumLeadMs: MINIMUM_LEAD_MS,
  retiredKeptMs: RETIRED_KEPT_MS,
  revokedKeptMs: REVOKED_KEPT_MS,
} = CALLER_TOKEN_POLICY;

// The caller token's keys, whose behaviour these tests hold to what its page documents.
const rotate = (ports: RotationPorts, now: Date, request?: RotationRequest) =>
  rotateKeys(ports, CALLER_TOKEN_POLICY, now, request);

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

    await rotate(ports, after(45 * MINUTE), { revoke: NEXT });
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

  it("revokes a signing key at once, with a new key that signs straight away, keeping the one scheduled", async () => {
    const ports = await rotated();
    const at = after(30 * MINUTE);

    const report = await rotate(ports, at, { revoke: FIRST });
    expect(report.events).toEqual([
      { event: "key_revoked", keyId: FIRST },
      {
        event: "key_generated",
        keyId: "20261106T123000Z",
        activeFrom: seconds(at),
      },
    ]);
    expect(ports.publicKeys()).toEqual([
      { keyId: NEXT, activeFrom: seconds(SWITCH) },
      {
        keyId: "20261106T123000Z",
        activeFrom: seconds(at),
        activeUntil: seconds(SWITCH),
      },
    ]);
    expect(ports.signingKid(at)).toBe("20261106T123000Z");
    expect(ports.signingKid(SWITCH)).toBe(NEXT);
  });

  it("never brings back the key a revoked signing key replaced", async () => {
    const ports = await rotated();
    await rotate(ports, after(MINUTE, SWITCH));
    const at = after(2 * MINUTE, SWITCH);

    const report = await rotate(ports, at, { revoke: NEXT });
    expect(report.events).toEqual([
      { event: "key_revoked", keyId: NEXT },
      {
        event: "key_generated",
        keyId: "20261113T120200Z",
        activeFrom: seconds(at),
      },
    ]);
    expect(ports.signingKid(at)).toBe("20261113T120200Z");
    expect(ports.edgeKids(at)).not.toContain(FIRST);
    expect(ports.publicKeys()).toContainEqual({
      keyId: FIRST,
      activeFrom: seconds(START),
      activeUntil: seconds(SWITCH),
    });

    const pruned = await rotate(ports, after(RETIRED_KEPT_MS, SWITCH));
    expect(pruned.events).toEqual([{ event: "key_pruned", keyId: FIRST }]);
  });

  it("revokes a scheduled key, scheduling another for the same moment, which the signing key stops at", async () => {
    const ports = await rotated();

    const report = await rotate(ports, after(30 * MINUTE), { revoke: NEXT });
    expect(report.events).toEqual([
      { event: "key_revoked", keyId: NEXT },
      {
        event: "key_generated",
        keyId: "20261106T123000Z",
        activeFrom: seconds(SWITCH),
      },
    ]);
    expect(ports.publicKeys()).toEqual([
      {
        keyId: FIRST,
        activeFrom: seconds(START),
        activeUntil: seconds(SWITCH),
      },
      { keyId: "20261106T123000Z", activeFrom: seconds(SWITCH) },
    ]);
  });

  it("schedules a revoked scheduled key's replacement the least lead ahead, moving the signing key's end with it", async () => {
    const ports = await rotated();
    const at = after(-10 * MINUTE, SWITCH);

    await rotate(ports, at, { revoke: NEXT });
    const replacement = seconds(after(MINIMUM_LEAD_MS, at));
    expect(ports.publicKeys()).toEqual([
      { keyId: FIRST, activeFrom: seconds(START), activeUntil: replacement },
      { keyId: "20261113T115000Z", activeFrom: replacement },
    ]);
    expect(ports.signingKid(SWITCH)).toBe(FIRST);
  });

  it("only removes a revoked key that has stopped signing", async () => {
    const ports = await rotated();
    await rotate(ports, after(MINUTE, SWITCH));

    const report = await rotate(ports, after(2 * MINUTE, SWITCH), {
      revoke: FIRST,
    });
    expect(report.events).toEqual([{ event: "key_revoked", keyId: FIRST }]);
    expect(ports.publicKids()).not.toContain(FIRST);
    expect(ports.signingKid(after(2 * MINUTE, SWITCH))).toBe(NEXT);
  });

  it("answers a revocation run again as done, changing nothing", async () => {
    const ports = await rotated();
    await rotate(ports, after(30 * MINUTE), { revoke: FIRST });
    const before = ports.state;

    const at = after(31 * MINUTE);
    const report = await rotate(ports, at, { revoke: FIRST });
    expect(report.events).toEqual([
      { event: "key_already_revoked", keyId: FIRST },
    ]);
    expect(ports.state).toBe(before);
    expect(ports.publicKids()).not.toContain(FIRST);
    expect(ports.signingKid(at)).toBe("20261106T123000Z");
  });

  it("forgets a revoked key a day after it was revoked", async () => {
    const ports = await rotated();
    const at = after(30 * MINUTE);
    await rotate(ports, at, { revoke: FIRST });

    await rotate(ports, after(REVOKED_KEPT_MS - 1000, at));
    expect(ports.state.revoked).toEqual([
      { keyId: FIRST, revokedAt: seconds(at) },
    ]);
    await rotate(ports, after(REVOKED_KEPT_MS, at));
    expect(ports.state.revoked).toEqual([]);
  });

  it("refuses to revoke a key it doesn't hold, changing nothing", async () => {
    const ports = new MemoryPorts();
    await rotate(ports, START);
    const before = ports.state;
    await expect(
      rotate(ports, after(MINUTE), { revoke: "20991231T000000Z" }),
    ).rejects.toThrow("The key to revoke is not one rotation holds");
    expect(ports.state).toBe(before);
  });

  it("never makes a key under an ID it has used, which a revocation in the same second could", async () => {
    const ports = new MemoryPorts();
    await rotate(ports, START);
    await expect(rotate(ports, START, { revoke: FIRST })).rejects.toThrow(
      `A key was made as ${FIRST} already`,
    );
  });
});
