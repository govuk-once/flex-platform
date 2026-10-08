import { describe, expect, it } from "vitest";

import { isPlatformName } from "./is-platform-name.ts";

describe("isPlatformName", () => {
  it.each(["a", "udp", "dev-1", "a1", `a${"b".repeat(31)}`])(
    "accepts %s",
    (name) => {
      expect(isPlatformName(name)).toBe(true);
    },
  );

  it.each([
    ["an empty name", ""],
    ["capitals", "Dev"],
    ["a leading digit", "1dev"],
    ["a leading hyphen", "-dev"],
    ["a trailing hyphen", "dev-"],
    ["a dot", "udp.evil"],
    ["a port", "udp:8443"],
    ["an underscore", "dev_1"],
    ["33 characters", `a${"b".repeat(32)}`],
  ])("refuses %s", (_, name) => {
    expect(isPlatformName(name)).toBe(false);
  });
});
