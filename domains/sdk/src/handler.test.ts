import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { requestContext } from "../test/fixtures/request-context.ts";
import { getTodo } from "../test/fixtures/routes/get-todo.ts";
import type { Todo, TodoError } from "../test/fixtures/schemas.ts";
import type { PairwiseId, PushId } from "./caller.ts";
import type {
  Caller,
  Handler,
  RequestContext,
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
      [Key in RegisteredRouteKey]: Exclude<
        keyof RouteContext<Key>,
        keyof RequestContext
      >;
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

  it("gives every handler the caller, a log instance, and the deadline's signal", () => {
    expectTypeOf<keyof RequestContext>().toEqualTypeOf<
      "caller" | "log" | "signal"
    >();
    expectTypeOf<Caller>().toEqualTypeOf<{
      readonly pairwiseId: PairwiseId;
      readonly pushId: PushId;
    }>();
    expectTypeOf<RouteContext<"GET /v1/todos">>().toExtend<RequestContext>();
    expectTypeOf<PairwiseId>().not.toExtend<PushId>();
    expectTypeOf<PushId>().not.toExtend<PairwiseId>();
    expectTypeOf<PairwiseId>().toExtend<string>();
  });

  it("lets any handler answer with a server error, which no route declares", () => {
    expectTypeOf<{
      status: 500 | 502 | 503 | 504;
    }>().toExtend<RouteResult<RegisteredRouteKey>>();
    expectTypeOf<{ status: 501 }>().not.toExtend<
      RouteResult<"GET /v1/todos">
    >();
    expectTypeOf<{ status: 502; body: TodoError }>().not.toExtend<
      RouteResult<"GET /v1/todos/{id}">
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
  });

  it("takes a failure the route declares as it takes a success", () => {
    expectTypeOf<{ status: 404; body: TodoError }>().toExtend<
      RouteResult<"GET /v1/todos/{id}">
    >();
    expectTypeOf<{ status: 404 }>().not.toExtend<
      RouteResult<"GET /v1/todos/{id}">
    >();
    expectTypeOf<{ status: 409; body: TodoError }>().not.toExtend<
      RouteResult<"GET /v1/todos/{id}">
    >();
    expectTypeOf<{ status: 404 }>().toExtend<
      RouteResult<"DELETE /v1/todos/{id}">
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

  it("runs the fixture's handler to a success and to the failure its route declares", () => {
    expect(getTodo({ ...requestContext(), params: { id: "1" } })).toEqual({
      status: 200,
      body: { id: "1", title: "Renew a passport", done: false },
    });
    expect(getTodo({ ...requestContext(), params: { id: "9" } })).toEqual({
      status: 404,
      body: { error: { code: "todo_not_found", message: "No such todo" } },
    });
  });

  it("accepts an async handler", () => {
    expectTypeOf<
      (
        context: RouteContext<"POST /v1/todos">,
      ) => Promise<{ status: 201; body: Todo }>
    >().toExtend<Handler<"POST /v1/todos">>();
  });
});
