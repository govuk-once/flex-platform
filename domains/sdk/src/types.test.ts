import { describe, expectTypeOf, it } from "vitest";

import type { MethodOf, PathParameters } from "./types.ts";

describe("PathParameters", () => {
  it("reads every parameter in a key", () => {
    expectTypeOf<
      PathParameters<"DELETE /v1/todos/{id}/links/{linkId}">
    >().toEqualTypeOf<"id" | "linkId">();
    expectTypeOf<PathParameters<"GET /v1/todos">>().toEqualTypeOf<never>();
  });
});

describe("MethodOf", () => {
  it("reads the method before the path", () => {
    expectTypeOf<MethodOf<"DELETE /v1/todos/{id}">>().toEqualTypeOf<"DELETE">();
  });
});
