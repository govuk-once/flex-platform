import { assert, describe, expect, it } from "vitest";

import { MemoryPorts } from "../../test/ports.ts";
import { CALLER_TOKEN_POLICY } from "./policy.ts";
import { revoke } from "./revoke.ts";
import { KeyCheckFailed, rotate as rotateKeys } from "./rotation.ts";

const {
  periodMs: ROTATION_PERIOD_MS,
  minimumLeadMs: MINIMUM_LEAD_MS,
  retiredKeptMs: RETIRED_KEPT_MS,
  revokedKeptMs: REVOKED_KEPT_MS,
} = CALLER_TOKEN_POLICY;

const rotate = (ports: MemoryPorts, now: Date) =>
  rotateKeys(ports, CALLER_TOKEN_POLICY, now);

// As the handler runs them: the revocation, then a run, which reads the tables again.
async function revokeAndRun(ports: MemoryPorts, now: Date, keyId: string) {
  const revoked = await revoke(ports, now, keyId);
  const { events } = await rotate(ports, now);
  return [revoked, ...events];
}

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
  ports.calls.length = 0;
  return ports;
}

describe("revoke", () => {
  it("takes the signing key from both tables in one transaction, while KMS fails every call", async () => {
    const ports = await rotated();
    ports.kmsDisabled = true;
    const at = after(30 * MINUTE);

    expect(await revoke(ports, at, FIRST)).toEqual({
      event: "key_revoked",
      keyId: FIRST,
    });
    // Nothing made and nothing checked.
    expect(ports.calls).toEqual(["commit"]);
    expect(ports.state.revoked).toEqual([
      { keyId: FIRST, revokedAt: seconds(at) },
    ]);
    expect(ports.publicKeys()).toEqual([
      { keyId: NEXT, activeFrom: seconds(SWITCH) },
    ]);
    // No key signs until a run makes one.
    expect(ports.signingKid(at)).toBeUndefined();
  });

  it("keeps the revocation when the run after it fails, and has a key signing once a run succeeds", async () => {
    const ports = await rotated();
    ports.kmsDisabled = true;
    const at = after(30 * MINUTE);

    await expect(revokeAndRun(ports, at, FIRST)).rejects.toThrow(
      "The KMS key is disabled",
    );
    expect(ports.publicKids()).toEqual([NEXT]);
    expect(ports.state.revoked.map(({ keyId }) => keyId)).toEqual([FIRST]);
    expect(ports.signingKid(at)).toBeUndefined();

    ports.kmsDisabled = false;
    await rotate(ports, after(45 * MINUTE));
    expect(ports.signingKid(after(45 * MINUTE))).toBe("20261106T124500Z");
  });

  it("revokes a key while another stored key fails its check, which stops only the run after it", async () => {
    const ports = await rotated();
    ports.undecryptable = NEXT;
    const at = after(30 * MINUTE);

    const error = await revokeAndRun(ports, at, FIRST).catch(
      (thrown: unknown) => thrown,
    );
    assert.instanceOf(error, KeyCheckFailed);
    expect(error).toMatchObject({ keyId: NEXT, stored: true });
    expect(ports.publicKids()).toEqual([NEXT]);
    expect(ports.state.revoked.map(({ keyId }) => keyId)).toEqual([FIRST]);
  });

  it("revokes the key that fails its check", async () => {
    const ports = await rotated();
    ports.undecryptable = NEXT;

    await revoke(ports, after(30 * MINUTE), NEXT);
    expect(ports.calls).toEqual(["commit"]);
    expect(ports.publicKids()).toEqual([FIRST]);
  });

  it("revokes a signing key at once, and the run makes a key that signs straight away, keeping the one scheduled", async () => {
    const ports = await rotated();
    const at = after(30 * MINUTE);

    expect(await revokeAndRun(ports, at, FIRST)).toEqual([
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

    await revoke(ports, at, NEXT);
    // Its end has passed, so it stays.
    expect(ports.publicKeys()).toContainEqual({
      keyId: FIRST,
      activeFrom: seconds(START),
      activeUntil: seconds(SWITCH),
    });
    expect(ports.signingKid(at)).toBeUndefined();

    const { events } = await rotate(ports, at);
    expect(events).toEqual([
      {
        event: "key_generated",
        keyId: "20261113T120200Z",
        activeFrom: seconds(at),
      },
    ]);
    expect(ports.signingKid(at)).toBe("20261113T120200Z");
    expect(ports.edgeKids(at)).not.toContain(FIRST);

    const pruned = await rotate(ports, after(RETIRED_KEPT_MS, SWITCH));
    expect(pruned.events).toEqual([{ event: "key_pruned", keyId: FIRST }]);
  });

  it("revokes a scheduled key, clearing the end of the key that was to hand over to it", async () => {
    const ports = await rotated();
    const at = after(30 * MINUTE);

    await revoke(ports, at, NEXT);
    expect(ports.publicKeys()).toEqual([
      { keyId: FIRST, activeFrom: seconds(START) },
    ]);
    expect(ports.signingKid(SWITCH)).toBe(FIRST);

    // The run schedules another for the same moment, which the signing key stops at.
    const { events } = await rotate(ports, at);
    expect(events).toEqual([
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

  it("leaves the signing key signing when a revoked scheduled key's replacement can't be made", async () => {
    const ports = await rotated();
    ports.kmsDisabled = true;

    await expect(revokeAndRun(ports, after(30 * MINUTE), NEXT)).rejects.toThrow(
      "The KMS key is disabled",
    );
    expect(ports.publicKeys()).toEqual([
      { keyId: FIRST, activeFrom: seconds(START) },
    ]);
    expect(ports.signingKid(after(MINUTE, SWITCH))).toBe(FIRST);
  });

  it("has a revoked scheduled key's replacement scheduled the least lead ahead, moving the signing key's end with it", async () => {
    const ports = await rotated();
    const at = after(-10 * MINUTE, SWITCH);

    await revokeAndRun(ports, at, NEXT);
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
    const at = after(2 * MINUTE, SWITCH);

    expect(await revokeAndRun(ports, at, FIRST)).toEqual([
      { event: "key_revoked", keyId: FIRST },
    ]);
    expect(ports.publicKids()).not.toContain(FIRST);
    expect(ports.signingKid(at)).toBe(NEXT);
  });

  it("answers a revocation run again as already revoked, changing nothing", async () => {
    const ports = await rotated();
    await revokeAndRun(ports, after(30 * MINUTE), FIRST);
    const before = ports.state;
    ports.calls.length = 0;

    const at = after(31 * MINUTE);
    expect(await revoke(ports, at, FIRST)).toEqual({
      event: "key_already_revoked",
      keyId: FIRST,
    });
    expect(ports.calls).toEqual([]);
    expect(ports.state).toBe(before);

    // The run after it does whatever else is due: here, nothing.
    expect(await revokeAndRun(ports, at, FIRST)).toEqual([
      { event: "key_already_revoked", keyId: FIRST },
    ]);
    expect(ports.state).toBe(before);
    expect(ports.signingKid(at)).toBe("20261106T123000Z");
  });

  it("refuses to revoke a key rotation neither holds nor has revoked, changing nothing", async () => {
    const ports = await rotated();
    const before = ports.state;

    await expect(
      revoke(ports, after(30 * MINUTE), "20991231T000000Z"),
    ).rejects.toThrow("The key to revoke is not one rotation holds");
    expect(ports.calls).toEqual([]);
    expect(ports.state).toBe(before);
  });

  it("writes nothing when the transaction fails, so the key is still held", async () => {
    const ports = await rotated();
    const before = ports.state;
    ports.failCommit = true;

    await expect(revoke(ports, after(30 * MINUTE), FIRST)).rejects.toThrow(
      "DynamoDB refused the transaction",
    );
    expect(ports.state).toBe(before);
  });

  it("is forgotten by a run a day after", async () => {
    const ports = await rotated();
    const at = after(30 * MINUTE);
    await revokeAndRun(ports, at, FIRST);

    await rotate(ports, after(REVOKED_KEPT_MS - 1000, at));
    expect(ports.state.revoked).toEqual([
      { keyId: FIRST, revokedAt: seconds(at) },
    ]);
    await rotate(ports, after(REVOKED_KEPT_MS, at));
    expect(ports.state.revoked).toEqual([]);
  });

  it("leaves a run in the second its key was made to make no key under the same ID", async () => {
    const ports = new MemoryPorts();
    await rotate(ports, START);

    await expect(revokeAndRun(ports, START, FIRST)).rejects.toThrow(
      `A key was made as ${FIRST} already`,
    );
    expect(ports.publicKids()).toEqual([]);
  });
});
