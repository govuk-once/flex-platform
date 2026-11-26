import { describe, expect, it } from "vitest";

import { isCamelCase } from "./is-camel-case.ts";

describe("isCamelCase", () => {
  it.each(["id", "linkId", "getTodo2", "a"])("accepts %s", (name) => {
    expect(isCamelCase(name)).toBe(true);
  });

  it.each(["", "Id", "2fa", "link-id", "link_id", "link id", "linkId!"])(
    "refuses %j",
    (name) => {
      expect(isCamelCase(name)).toBe(false);
    },
  );
});
