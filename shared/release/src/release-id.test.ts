import { uuidV7 } from "@repo/utils/uuid-v7";
import { describe, expect, it } from "vitest";

import { isReleaseId, releaseRequestedAt } from "./release-id.ts";

describe("isReleaseId", () => {
  it("takes a UUID of version 7", () => {
    expect(isReleaseId(uuidV7(1_800_000_000_000, new Uint8Array(10)))).toBe(
      true,
    );
  });

  it.each([
    "",
    "00000000-0000-4000-8000-000000000000",
    "00000000-0000-7000-c000-000000000000",
    "00000000-0000-7000-8000-00000000000A",
    "00000000000070008000000000000000",
  ])("refuses %j", (value) => {
    expect(isReleaseId(value)).toBe(false);
  });
});

describe("releaseRequestedAt", () => {
  it("reads the millisecond the ID was made in, whatever its random bits", () => {
    const at = 1_800_000_000_123;

    expect(releaseRequestedAt(uuidV7(at, new Uint8Array(10)))).toBe(at);
    expect(releaseRequestedAt(uuidV7(at, new Uint8Array(10).fill(0xff)))).toBe(
      at,
    );
  });

  it("throws for a value that isn't a release's ID", () => {
    expect(() =>
      releaseRequestedAt("00000000-0000-4000-8000-000000000000"),
    ).toThrow("isn't a release's ID");
  });
});
