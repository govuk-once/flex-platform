import { describe, expect, it } from "vitest";

import { MemoryPorts } from "../../test/ports.ts";
import {
  MINIMUM_LEAD_MS,
  RETIRED_KEPT_MS,
  REVOKED_KEPT_MS,
  rotate,
  ROTATION_PERIOD_MS,
} from "./rotation.ts";

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
  it("makes a key that signs at once, published before the edge is given it", async () => {
    const ports = new MemoryPorts();
    const report = await rotate(ports, START);

    expect(report.events).toEqual([
      { event: "key_generated", kid: FIRST, signsFrom: seconds(START) },
    ]);
    expect(ports.signingKid(START)).toBe(FIRST);
    expect(ports.calls).toEqual([
      `generate ${FIRST}`,
      "writeState",
      "publish",
      "distribute",
    ]);
  });

  it("schedules the next key a period after the last started, and gives it to the edge now", async () => {
    const ports = await rotated();

    expect(ports.distributed.map(({ kid }) => kid)).toEqual([FIRST, NEXT]);
    expect(ports.signingKid(after(15 * MINUTE))).toBe(FIRST);
    expect(ports.publishedKeys()).toEqual([
      { kid: FIRST, signsFrom: seconds(START), signsUntil: seconds(SWITCH) },
      { kid: NEXT, signsFrom: seconds(SWITCH) },
    ]);
  });

  it("does nothing when nothing is due", async () => {
    const ports = await rotated();
    const report = await rotate(ports, after(30 * MINUTE));

    expect(report.events).toEqual([]);
  });

  it("switches every edge at the scheduled moment, with no run between", async () => {
    const ports = await rotated();

    expect(ports.signingKid(after(-1000, SWITCH))).toBe(FIRST);
    expect(ports.signingKid(SWITCH)).toBe(NEXT);
  });

  it("takes the old key from the edge after the switch, and from the gateways once no token it signed lives", async () => {
    const ports = await rotated();

    const run = await rotate(ports, after(MINUTE, SWITCH));
    expect(run.events.map(({ event }) => event)).toEqual(["key_generated"]);
    expect(ports.distributed.map(({ kid }) => kid)).toEqual([
      NEXT,
      "20261113T120100Z",
    ]);
    expect(ports.publishedKids()).toContain(FIRST);

    const pruned = await rotate(ports, after(RETIRED_KEPT_MS, SWITCH));
    expect(pruned.events).toEqual([{ event: "key_pruned", kid: FIRST }]);
    expect(ports.publishedKids()).not.toContain(FIRST);
  });

  it("schedules the next key the least lead ahead when the runs stopped for longer than a period", async () => {
    const ports = new MemoryPorts();
    await rotate(ports, START);
    const late = after(ROTATION_PERIOD_MS * 2);
    const report = await rotate(ports, late);

    expect(report.events).toEqual([
      {
        event: "key_generated",
        kid: "20261120T120000Z",
        signsFrom: seconds(after(MINIMUM_LEAD_MS, late)),
      },
    ]);
    expect(ports.signingKid(late)).toBe(FIRST);
  });

  it("fails when the edge couldn't be given its keys, and gives them on the next run", async () => {
    const ports = new MemoryPorts();
    await rotate(ports, START);
    ports.failDistribution = true;

    await expect(rotate(ports, after(15 * MINUTE))).rejects.toThrow(
      "SSM refused",
    );
    expect(ports.publishedKids()).toEqual([FIRST, NEXT]);
    expect(ports.distributed).toHaveLength(1);

    ports.failDistribution = false;
    const retried = await rotate(ports, after(30 * MINUTE));
    expect(retried.events).toEqual([]);
    expect(ports.distributed).toHaveLength(2);
  });

  it("gives the edge no key it couldn't publish, and keeps the key it made", async () => {
    const ports = new MemoryPorts();
    ports.failPublish = true;
    await expect(rotate(ports, START)).rejects.toThrow("S3 refused the keys");
    expect(ports.distributed).toHaveLength(0);
    expect(ports.state.keys).toHaveLength(1);

    ports.failPublish = false;
    await rotate(ports, after(15 * MINUTE));
    expect(ports.signingKid(after(15 * MINUTE))).toBe(FIRST);
  });

  it("revokes a signing key at once, with a new key that signs straight away, keeping the one scheduled", async () => {
    const ports = await rotated();
    const at = after(30 * MINUTE);

    const report = await rotate(ports, at, { revoke: FIRST });
    expect(report.events).toEqual([
      { event: "key_revoked", kid: FIRST },
      {
        event: "key_generated",
        kid: "20261106T123000Z",
        signsFrom: seconds(at),
      },
    ]);
    expect(ports.publishedKeys()).toEqual([
      { kid: NEXT, signsFrom: seconds(SWITCH) },
      {
        kid: "20261106T123000Z",
        signsFrom: seconds(at),
        signsUntil: seconds(SWITCH),
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
      { event: "key_revoked", kid: NEXT },
      {
        event: "key_generated",
        kid: "20261113T120200Z",
        signsFrom: seconds(at),
      },
    ]);
    expect(ports.signingKid(at)).toBe("20261113T120200Z");
    expect(ports.distributed.map(({ kid }) => kid)).not.toContain(FIRST);
    expect(ports.publishedKeys()).toContainEqual({
      kid: FIRST,
      signsFrom: seconds(START),
      signsUntil: seconds(SWITCH),
    });

    const pruned = await rotate(ports, after(RETIRED_KEPT_MS, SWITCH));
    expect(pruned.events).toEqual([{ event: "key_pruned", kid: FIRST }]);
  });

  it("revokes a scheduled key, scheduling another for the same moment, which the signing key stops at", async () => {
    const ports = await rotated();

    const report = await rotate(ports, after(30 * MINUTE), { revoke: NEXT });
    expect(report.events).toEqual([
      { event: "key_revoked", kid: NEXT },
      {
        event: "key_generated",
        kid: "20261106T123000Z",
        signsFrom: seconds(SWITCH),
      },
    ]);
    expect(ports.publishedKeys()).toEqual([
      { kid: FIRST, signsFrom: seconds(START), signsUntil: seconds(SWITCH) },
      { kid: "20261106T123000Z", signsFrom: seconds(SWITCH) },
    ]);
  });

  it("schedules a revoked scheduled key's replacement the least lead ahead, moving the signing key's end with it", async () => {
    const ports = await rotated();
    const at = after(-10 * MINUTE, SWITCH);

    await rotate(ports, at, { revoke: NEXT });
    const replacement = seconds(after(MINIMUM_LEAD_MS, at));
    expect(ports.publishedKeys()).toEqual([
      { kid: FIRST, signsFrom: seconds(START), signsUntil: replacement },
      { kid: "20261113T115000Z", signsFrom: replacement },
    ]);
    expect(ports.signingKid(SWITCH)).toBe(FIRST);
  });

  it("only removes a revoked key that has stopped signing", async () => {
    const ports = await rotated();
    await rotate(ports, after(MINUTE, SWITCH));

    const report = await rotate(ports, after(2 * MINUTE, SWITCH), {
      revoke: FIRST,
    });
    expect(report.events).toEqual([{ event: "key_revoked", kid: FIRST }]);
    expect(ports.publishedKids()).not.toContain(FIRST);
    expect(ports.signingKid(after(2 * MINUTE, SWITCH))).toBe(NEXT);
  });

  it("finishes a revocation whose writes failed when it is run again", async () => {
    const ports = await rotated();
    ports.failPublish = true;
    await expect(
      rotate(ports, after(30 * MINUTE), { revoke: FIRST }),
    ).rejects.toThrow("S3 refused the keys");
    expect(ports.publishedKids()).toContain(FIRST);

    ports.failPublish = false;
    const at = after(31 * MINUTE);
    const report = await rotate(ports, at, { revoke: FIRST });
    expect(report.events).toEqual([
      { event: "key_already_revoked", kid: FIRST },
    ]);
    expect(ports.publishedKids()).not.toContain(FIRST);
    expect(ports.signingKid(at)).toBe("20261106T123000Z");
  });

  it("forgets a revoked key a day after it was revoked", async () => {
    const ports = await rotated();
    const at = after(30 * MINUTE);
    await rotate(ports, at, { revoke: FIRST });

    await rotate(ports, after(REVOKED_KEPT_MS - 1000, at));
    expect(ports.state.revoked).toEqual([
      { kid: FIRST, revokedAt: seconds(at) },
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
