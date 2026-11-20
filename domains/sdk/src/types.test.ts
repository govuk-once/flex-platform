import { describe, expectTypeOf, it } from "vitest";

import type { MethodOf } from "./types.ts";

describe("MethodOf", () => {
  it("reads the method before the path", () => {
    expectTypeOf<MethodOf<"DELETE /v1/todos/{id}">>().toEqualTypeOf<"DELETE">();
  });
});
