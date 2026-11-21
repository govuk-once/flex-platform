import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import {
  badGateway,
  badRequest,
  conflict,
  gatewayTimeout,
  internalError,
  notFound,
  tooManyRequests,
  unavailable,
  unprocessable,
} from "./failures.ts";
import type { RouteResult, RouteResultOf } from "./handler.ts";

const error = { error: { code: "todo_not_found", message: "No such todo" } };

describe("the failure helpers", () => {
  it("answers a failure of the route's own, with the body it is given or none", () => {
    expect(badRequest(error)).toEqual({ status: 400, body: error });
    expect(notFound(error)).toEqual({ status: 404, body: error });
    expect(conflict(error)).toEqual({ status: 409, body: error });
    expect(unprocessable(error)).toEqual({ status: 422, body: error });
    expect(tooManyRequests(error)).toEqual({ status: 429, body: error });

    expect(notFound()).toEqual({ status: 404 });
    expect(notFound()).not.toHaveProperty("body");
  });

  it.each([
    [internalError, 500],
    [badGateway, 502],
    [unavailable, 503],
    [gatewayTimeout, 504],
  ])("answers a server error with status %#, and no body", (helper, status) => {
    expect(helper()).toEqual({ status });
    expectTypeOf(helper).parameters.toEqualTypeOf<[]>();
  });

  it("keeps the status as a literal, so a handler is held to what its route declares", () => {
    expectTypeOf(notFound()).toEqualTypeOf<{ readonly status: 404 }>();
    expectTypeOf(notFound(error)).toExtend<RouteResult<"GET /v1/todos/{id}">>();
    expectTypeOf(notFound()).not.toExtend<RouteResult<"GET /v1/todos/{id}">>();
    expectTypeOf(notFound()).toExtend<RouteResult<"DELETE /v1/todos/{id}">>();
    expectTypeOf(conflict(error)).not.toExtend<
      RouteResult<"GET /v1/todos/{id}">
    >();
    expectTypeOf(badGateway()).toExtend<RouteResult<"GET /v1/todos">>();
  });

  it("takes a body whose schema names its values", () => {
    interface LicenceRoute {
      readonly responses: {
        readonly 200: null;
        readonly 404: z.ZodObject<{
          code: z.ZodEnum<{
            not_found: "not_found";
            not_available: "not_available";
          }>;
        }>;
      };
    }

    const answer = (): RouteResultOf<LicenceRoute> =>
      notFound({ code: "not_available" });

    expect(answer()).toEqual({ status: 404, body: { code: "not_available" } });
  });
});
