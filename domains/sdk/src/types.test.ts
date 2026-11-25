import { describe, expectTypeOf, it } from "vitest";

import type { MethodOf, PathParameters } from "./types.ts";

describe("MethodOf", () => {
  it("reads the method before the path", () => {
    expectTypeOf<MethodOf<"DELETE /v1/todos/{id}">>().toEqualTypeOf<"DELETE">();
  });
});

describe("PathParameters", () => {
  it("reads every parameter in a template", () => {
    expectTypeOf<
      PathParameters<"/v1/todos/{id}/links/{linkId}">
    >().toEqualTypeOf<"id" | "linkId">();
    expectTypeOf<PathParameters<"/v1/todos">>().toEqualTypeOf<never>();
  });
});
