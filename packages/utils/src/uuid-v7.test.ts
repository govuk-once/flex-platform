import { describe, expect, it } from "vitest";

import { uuidV7 } from "./uuid-v7.ts";

const RANDOM = new Uint8Array(10).fill(0xff);

describe("uuidV7", () => {
  it("holds the time in its first 48 bits, then the version and the variant", () => {
    expect(uuidV7(0x0123_4567_89ab, new Uint8Array(10))).toBe(
      "01234567-89ab-7000-8000-000000000000",
    );
  });

  it("keeps the version and variant over random bits that would hide them", () => {
    expect(uuidV7(0, RANDOM)).toBe("00000000-0000-7fff-bfff-ffffffffffff");
  });

  it("sorts as text in the order the UUIDs were made, whatever their random bits", () => {
    const times = [0, 1, 255, 256, 2 ** 32 - 1, 2 ** 32, 1_800_000_000_000];
    const uuids = times.map((time, index) =>
      uuidV7(time, new Uint8Array(10).fill(255 - index)),
    );

    expect([...uuids].sort()).toEqual(uuids);
  });

  it.each([-1, 0.5, 2 ** 48])("refuses a time of %s", (now) => {
    expect(() => uuidV7(now, RANDOM)).toThrow(RangeError);
  });

  it("refuses random bytes of another length", () => {
    expect(() => uuidV7(0, new Uint8Array(16))).toThrow(RangeError);
  });
});
