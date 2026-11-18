import { uuidV7 } from "@repo/utils/uuid-v7";
import { describe, expect, it } from "vitest";

import { isReleaseId } from "./release-id.ts";

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
