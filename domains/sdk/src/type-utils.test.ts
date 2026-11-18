import { describe, expectTypeOf, it } from "vitest";

import type { PathParameters } from "./type-utils.ts";

describe("PathParameters", () => {
  it("reads every parameter in a template", () => {
    expectTypeOf<
      PathParameters<"/v1/todos/{id}/links/{linkId}">
    >().toEqualTypeOf<"id" | "linkId">();
    expectTypeOf<PathParameters<"/v1/todos">>().toEqualTypeOf<never>();
  });
});
