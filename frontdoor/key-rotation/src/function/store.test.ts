import { assert, describe, expect, it } from "vitest";

import { FakeDynamoDB } from "../../test/dynamodb.ts";
import { MemoryPorts, publicKeyDer } from "../../test/ports.ts";
import { CALLER_TOKEN_POLICY } from "./policy.ts";
import { revoke } from "./revoke.ts";
import { rotate, type RotationPorts } from "./rotation.ts";
import type { HeldKey, KeyChanges } from "./state.ts";
import { stateOf, tablePorts } from "./store.ts";

const TABLES = {
  privateKeys: "frontdoor-sandbox-caller-token-private-keys",
  publicKeys: "frontdoor-sandbox-caller-token-public-keys",
};

const START = new Date("2026-11-06T12:00:00Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const after = (ms: number) => new Date(START.getTime() + ms);
const seconds = (at: Date) => String(Math.floor(at.getTime() / 1000));

const FIRST = "20261106T120000Z";
const NEXT = "20261106T121500Z";

const PUBLIC_KEY = publicKeyDer();
const key = (
  keyId: string,
  activeFrom: number,
  activeUntil?: number,
): HeldKey => ({
  keyId,
  publicKey: PUBLIC_KEY,
  privateKey: new Uint8Array(Buffer.from(`private ${keyId}`)),
  activeFrom,
  ...(activeUntil !== undefined && { activeUntil }),
});
const NONE: KeyChanges = { put: [], remove: [], revoke: [], forget: [] };

// Rotation over the tables in a fake DynamoDB, with KMS in memory.
function rotation() {
  const dynamodb = new FakeDynamoDB();
  const memory = new MemoryPorts();
  const ports: RotationPorts = {
    ...tablePorts(dynamodb.client, TABLES),
    generate: (keyId) => memory.generate(keyId),
    check: (held) => memory.check(held),
  };
  // As the handler runs them: a revocation first, then the run.
  const run = async (at: Date, keyId?: string) => {
    if (keyId !== undefined) await revoke(ports, at, keyId);
    return rotate(ports, CALLER_TOKEN_POLICY, at);
  };
  const ids = (table: string) =>
    dynamodb
      .items(table)
      .map((item) => item.keyId?.S)
      .sort();
  return { dynamodb, memory, ports, run, ids };
}

describe("tablePorts", () => {
  it("reads empty tables as no keys, never changed", async () => {
    const { ports } = rotation();
    expect(await ports.read()).toEqual({ version: 0, keys: [], revoked: [] });
  });

  it("reads each table whole and consistently, page after page, the public keys first", async () => {
    const { dynamodb, ports, run } = rotation();
    await run(START);
    await run(after(15 * MINUTE));
    const whole = await ports.read();
    dynamodb.pageSize = 1;
    dynamodb.commands.length = 0;

    expect(await ports.read()).toEqual(whole);
    const scan = (table: string) => `Scan ${table} consistently`;
    expect(dynamodb.commands).toEqual([
      // Two keys and the version.
      ...Array.from({ length: 3 }, () => scan(TABLES.publicKeys)),
      ...Array.from({ length: 2 }, () => scan(TABLES.privateKeys)),
    ]);
  });

  it("keeps each key in both tables, the private key only in the private one", async () => {
    const { dynamodb, run } = rotation();
    await run(START);
    await run(after(15 * MINUTE));

    const switchAt = seconds(after(CALLER_TOKEN_POLICY.periodMs));
    expect(dynamodb.items(TABLES.privateKeys)).toEqual([
      {
        keyId: { S: FIRST },
        privateKey: { B: new Uint8Array(Buffer.from(`private ${FIRST}`)) },
        activeFrom: { N: seconds(START) },
        activeUntil: { N: switchAt },
      },
      {
        keyId: { S: NEXT },
        privateKey: { B: new Uint8Array(Buffer.from(`private ${NEXT}`)) },
        activeFrom: { N: switchAt },
      },
    ]);
    expect(dynamodb.items(TABLES.publicKeys)).toEqual([
      { keyId: { S: "#version" }, version: { N: "2" } },
      expect.objectContaining({
        keyId: { S: FIRST },
        activeFrom: { N: seconds(START) },
        activeUntil: { N: switchAt },
      }) as unknown,
      expect.objectContaining({ keyId: { S: NEXT } }) as unknown,
    ]);
    expect(JSON.stringify(dynamodb.items(TABLES.publicKeys))).not.toContain(
      "privateKey",
    );
  });

  it("writes nothing on a run with nothing due", async () => {
    const { dynamodb, run } = rotation();
    await run(START);
    await run(after(15 * MINUTE));
    dynamodb.commands.length = 0;

    await run(after(30 * MINUTE));
    expect(dynamodb.commands).toEqual([
      `Scan ${TABLES.publicKeys} consistently`,
      `Scan ${TABLES.privateKeys} consistently`,
    ]);
  });

  it("keeps a revoked key's ID in its key's place, and forgets it a day later", async () => {
    const { run, ids, ports } = rotation();
    await run(START);
    await run(after(15 * MINUTE));

    await run(after(30 * MINUTE), NEXT);
    expect(ids(TABLES.privateKeys)).toEqual([FIRST, "20261106T123000Z"]);
    expect(ids(TABLES.publicKeys)).toEqual([
      "#version",
      FIRST,
      NEXT,
      "20261106T123000Z",
    ]);
    expect((await ports.read()).revoked).toEqual([
      { keyId: NEXT, revokedAt: Number(seconds(after(30 * MINUTE))) },
    ]);

    // Run again, as after a write that failed: nothing left to write.
    await run(after(31 * MINUTE), NEXT);
    await run(after(30 * MINUTE + DAY));
    expect(ids(TABLES.publicKeys)).not.toContain(NEXT);
  });

  it("revokes in one transaction that deletes the private key, writes the record in the public key's place and clears the end before it, asking nothing of KMS", async () => {
    const { dynamodb, memory, ports, run } = rotation();
    await run(START);
    await run(after(15 * MINUTE));
    dynamodb.commands.length = 0;
    memory.calls.length = 0;
    memory.kmsDisabled = true;

    await revoke(ports, after(30 * MINUTE), NEXT);
    expect(dynamodb.commands).toEqual([
      `Scan ${TABLES.publicKeys} consistently`,
      `Scan ${TABLES.privateKeys} consistently`,
      "TransactWriteItems",
    ]);
    expect(memory.calls).toEqual([]);
    expect(dynamodb.items(TABLES.privateKeys)).toEqual([
      {
        keyId: { S: FIRST },
        privateKey: { B: new Uint8Array(Buffer.from(`private ${FIRST}`)) },
        activeFrom: { N: seconds(START) },
      },
    ]);
    expect(dynamodb.items(TABLES.publicKeys)).toEqual([
      { keyId: { S: "#version" }, version: { N: "3" } },
      {
        keyId: { S: FIRST },
        publicKey: { B: expect.any(Uint8Array) as unknown },
        activeFrom: { N: seconds(START) },
      },
      { keyId: { S: NEXT }, revokedAt: { N: seconds(after(30 * MINUTE)) } },
    ]);
  });

  it("removes a key from both tables once it has stopped long enough", async () => {
    const { run, ids } = rotation();
    await run(START);
    await run(after(15 * MINUTE));
    const switchAt = after(CALLER_TOKEN_POLICY.periodMs);

    await run(new Date(switchAt.getTime() + CALLER_TOKEN_POLICY.retiredKeptMs));
    expect(ids(TABLES.privateKeys)).not.toContain(FIRST);
    expect(ids(TABLES.publicKeys)).not.toContain(FIRST);
  });

  it("refuses a writer whose view is stale, keeping the change that was made", async () => {
    const { dynamodb, ports } = rotation();
    await ports.commit(0, { ...NONE, put: [key(FIRST, 1)] });
    const seen = await ports.read();

    await ports.commit(seen.version, { ...NONE, put: [key(NEXT, 2)] });
    await expect(
      ports.commit(seen.version, { ...NONE, remove: [FIRST] }),
    ).rejects.toThrow(
      "The key tables changed since this run read them, so it wrote nothing",
    );
    expect((await ports.read()).keys.map(({ keyId }) => keyId)).toEqual([
      FIRST,
      NEXT,
    ]);
    expect(dynamodb.items(TABLES.privateKeys)).toHaveLength(2);
  });

  it("refuses a second first writer", async () => {
    const { ports } = rotation();
    await ports.commit(0, { ...NONE, put: [key(FIRST, 1)] });
    await expect(
      ports.commit(0, { ...NONE, put: [key(NEXT, 2)] }),
    ).rejects.toThrow("changed since this run read them");
  });

  it("sends a change as one transaction, which leaves nothing half written when it fails", async () => {
    const { dynamodb, ports } = rotation();
    await ports.commit(0, { ...NONE, put: [key(FIRST, 1)] });
    const before = structuredClone([...dynamodb.tables]);
    dynamodb.commands.length = 0;
    dynamodb.failNext = true;

    await expect(
      ports.commit(1, {
        ...NONE,
        put: [key(NEXT, 2)],
        revoke: [{ keyId: FIRST, revokedAt: 2 }],
      }),
    ).rejects.toThrow("InternalServerError");
    expect(dynamodb.commands).toEqual(["TransactWriteItems"]);
    expect([...dynamodb.tables]).toEqual(before);
  });
});

describe("stateOf", () => {
  const privateItem = (keyId: string, activeFrom = "1") => ({
    keyId: { S: keyId },
    privateKey: { B: new Uint8Array([1]) },
    activeFrom: { N: activeFrom },
  });
  const publicItem = (keyId: string, activeFrom = "1") => ({
    keyId: { S: keyId },
    publicKey: { B: new Uint8Array([2]) },
    activeFrom: { N: activeFrom },
  });
  const version = { keyId: { S: "#version" }, version: { N: "3" } };

  it("reads a key from both tables, and a revoked key from the public one", () => {
    const state = stateOf(
      TABLES,
      [privateItem(FIRST)],
      [
        version,
        publicItem(FIRST),
        { keyId: { S: NEXT }, revokedAt: { N: "2" } },
      ],
    );
    expect(state.version).toBe(3);
    expect(state.keys.map(({ keyId }) => keyId)).toEqual([FIRST]);
    expect(state.revoked).toEqual([{ keyId: NEXT, revokedAt: 2 }]);
  });

  it.each([
    [
      "a public key without its private key",
      [],
      [version, publicItem(FIRST)],
      TABLES.privateKeys,
    ],
    [
      "a private key without its public key",
      [privateItem(FIRST)],
      [version],
      TABLES.privateKeys,
    ],
    [
      "a key whose times differ",
      [privateItem(FIRST, "1")],
      [version, publicItem(FIRST, "2")],
      TABLES.privateKeys,
    ],
    [
      "a revoked key whose private key is still held",
      [privateItem(FIRST)],
      [version, { keyId: { S: FIRST }, revokedAt: { N: "2" } }],
      TABLES.privateKeys,
    ],
    [
      "keys without a version",
      [privateItem(FIRST)],
      [publicItem(FIRST)],
      TABLES.publicKeys,
    ],
    [
      "an item that isn't a key",
      [],
      [version, { keyId: { S: "../x" } }],
      TABLES.publicKeys,
    ],
    [
      "an end before the start",
      [{ ...privateItem(FIRST, "2"), activeUntil: { N: "1" } }],
      [version],
      TABLES.privateKeys,
    ],
    [
      "a start that isn't a whole second",
      [privateItem(FIRST, "1.5")],
      [version],
      TABLES.privateKeys,
    ],
  ])("refuses %s", (_, privateItems, publicItems, table) => {
    const error = (() => {
      try {
        stateOf(TABLES, privateItems, publicItems);
      } catch (thrown) {
        return thrown;
      }
      return undefined;
    })();
    assert.instanceOf(error, Error);
    expect(error.message).toBe(`The table ${table} doesn't hold a key state`);
  });
});
