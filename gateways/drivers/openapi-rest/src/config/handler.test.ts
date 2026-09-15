import type { BrandedHandler, HandlerOf } from "@repo/gateway-config";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { OpenApiRestClient, OpenApiRestHandler } from "../types.ts";
import type { openapiRest } from "./definition.ts";
import { defineHandler } from "./handler.ts";

describe("defineHandler", () => {
  it("returns the function it was given", () => {
    const fn = () => Promise.resolve({ outcome: "ok", data: null });
    expect(defineHandler(fn)).toBe(fn);
  });

  it("keeps the declared input and the returned outcomes on the branded type", () => {
    const handler = defineHandler(async (_input: { id: string }, client) => {
      const response = await client.request({ method: "GET", path: "/x" });
      if (response.status === 404) return { outcome: "absent", data: null };
      return client.mapResponse(response);
    });
    expectTypeOf(handler).toEqualTypeOf<
      OpenApiRestHandler<
        { id: string },
        "absent" | "ok" | "created" | "accepted" | "no_content"
      >
    >();
    expectTypeOf(handler).parameter(0).toEqualTypeOf<{ id: string }>();
    // Never called; only its body is typechecked.
    const misuse = (client: OpenApiRestClient) =>
      // @ts-expect-error the declared input is checked at the call
      handler(123, client);
    expect(misuse).toBeTypeOf("function");
  });

  it("is assignable to the driver's handler slot whatever it declares", () => {
    type Slot = HandlerOf<ReturnType<typeof openapiRest>>;
    const handler = defineHandler((input: { id: string }) =>
      Promise.resolve({ outcome: "ok", data: input.id }),
    );
    expectTypeOf(handler).toExtend<Slot>();
    expectTypeOf<Slot>().toEqualTypeOf<OpenApiRestHandler>();
    expectTypeOf(handler).not.toExtend<
      BrandedHandler<"other", (input: never) => Promise<never>>
    >();
  });
});
