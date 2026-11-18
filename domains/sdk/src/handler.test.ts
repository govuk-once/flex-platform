import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import type { Todo } from "../test/fixtures/schemas.ts";
import type { HandlerRejectionCode } from "./errors.ts";
import type {
  Handler,
  Rejection,
  RouteContext,
  RouteContextOf,
  RouteResult,
  RouteResultOf,
} from "./handler.ts";
import type { RegisteredRouteKey } from "./register.ts";

// The fixture's domain is registered for the whole program, by its `declare module`, so these
// look its routes up by key.
describe("Handler", () => {
  it("gives each handler the parts its route declares, and nothing else", () => {
    expectTypeOf<{
      [Key in RegisteredRouteKey]: Exclude<keyof RouteContext<Key>, "reject">;
    }>().toEqualTypeOf<{
      "GET /v1/todos": "query";
      "GET /v1/todos/{id}": "params";
      "POST /v1/todos": "body";
      "PATCH /v1/todos/{id}": "params" | "body";
      "DELETE /v1/todos/{id}": "params";
    }>();

    expectTypeOf<RouteContext<"GET /v1/todos">["query"]>().toEqualTypeOf<{
      done?: boolean | undefined;
    }>();
    expectTypeOf<RouteContext<"GET /v1/todos/{id}">["params"]>().toEqualTypeOf<{
      id: string;
    }>();
    expectTypeOf<RouteContext<"POST /v1/todos">["body"]>().toEqualTypeOf<{
      title: string;
    }>();
    expectTypeOf<
      RouteContext<"PATCH /v1/todos/{id}">["params"]
    >().toEqualTypeOf<{ id: string }>();
    expectTypeOf<RouteContext<"PATCH /v1/todos/{id}">["body"]>().toEqualTypeOf<{
      title?: string | undefined;
      done?: boolean | undefined;
    }>();
  });

  it("lets each handler reject with its route's codes and any handler's", () => {
    type RejectCode<Key extends RegisteredRouteKey> = Parameters<
      RouteContext<Key>["reject"]
    >[0];

    expectTypeOf<{
      [Key in RegisteredRouteKey]: Exclude<
        RejectCode<Key>,
        HandlerRejectionCode
      >;
    }>().toEqualTypeOf<{
      "GET /v1/todos": never;
      "GET /v1/todos/{id}": "not_found";
      "POST /v1/todos": "conflict";
      "PATCH /v1/todos/{id}": "not_found";
      "DELETE /v1/todos/{id}": "not_found";
    }>();
    expectTypeOf<HandlerRejectionCode>().toExtend<
      RejectCode<"GET /v1/todos">
    >();
  });

  it("holds each handler to the results its route declares", () => {
    expectTypeOf<{ status: 200; body: Todo }>().toExtend<
      RouteResult<"GET /v1/todos/{id}">
    >();
    expectTypeOf<{ status: 201; body: Todo }>().not.toExtend<
      RouteResult<"GET /v1/todos/{id}">
    >();
    expectTypeOf<{ status: 204 }>().toExtend<
      RouteResult<"PATCH /v1/todos/{id}">
    >();
    expectTypeOf<{ status: 204; body: object }>().not.toExtend<
      RouteResult<"PATCH /v1/todos/{id}">
    >();
    expectTypeOf<Rejection<"conflict">>().toExtend<
      RouteResult<"POST /v1/todos">
    >();
    expectTypeOf<Rejection<"not_found">>().not.toExtend<
      RouteResult<"POST /v1/todos">
    >();
  });

  it("reads a request as the schema's output and a response as its input", () => {
    const DueSchema = z.object({
      due: z.iso.datetime().transform((value) => new Date(value)),
    });

    interface DueRoute {
      readonly body: typeof DueSchema;
      readonly responses: { readonly 200: typeof DueSchema };
    }

    expectTypeOf<RouteContextOf<DueRoute>["body"]>().toEqualTypeOf<{
      due: Date;
    }>();
    expectTypeOf<{ status: 200; body: { due: string } }>().toExtend<
      RouteResultOf<DueRoute>
    >();
    expectTypeOf<{ status: 200; body: { due: Date } }>().not.toExtend<
      RouteResultOf<DueRoute>
    >();
    expect(DueSchema.parse({ due: "2026-11-18T09:00:00Z" }).due).toBeInstanceOf(
      Date,
    );
  });

  it("accepts an async handler", () => {
    expectTypeOf<
      (
        context: RouteContext<"POST /v1/todos">,
      ) => Promise<{ status: 201; body: Todo }>
    >().toExtend<Handler<"POST /v1/todos">>();
  });
});
