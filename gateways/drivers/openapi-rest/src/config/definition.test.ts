import type { HandlerOf, OperationFields } from "@repo/gateway-config";
import { defineGateway } from "@repo/gateway-config";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { OpenApiRestHandler } from "../types.ts";
import { OPENAPI_REST_DRIVER_TYPE } from "../types.ts";
import type { OpenApiRestOperationFields } from "./definition.ts";
import { openapiRest } from "./definition.ts";

const SPEC = "https://example.test/openapi.yml";

describe("openapiRest", () => {
  it("builds a driver definition naming its type and spec", () => {
    const definition = openapiRest({ spec: SPEC });
    expect(definition).toMatchObject({
      type: OPENAPI_REST_DRIVER_TYPE,
      spec: SPEC,
    });
    expect(Object.keys(definition)).toEqual(["type", "createExecutor", "spec"]);
  });

  it("carries headers and the response limit when given", () => {
    const definition = openapiRest({
      spec: SPEC,
      headers: { "x-api-version": "2" },
      maxResponseBytes: 4096,
    });
    expect(definition).toMatchObject({
      type: OPENAPI_REST_DRIVER_TYPE,
      spec: SPEC,
      headers: { "x-api-version": "2" },
      maxResponseBytes: 4096,
    });
    expect(Object.keys(definition)).toEqual([
      "type",
      "createExecutor",
      "spec",
      "headers",
      "maxResponseBytes",
    ]);
  });

  it("types the driver with a literal type discriminator", () => {
    const driver = openapiRest({ spec: SPEC });
    expectTypeOf(driver.type).toEqualTypeOf<"openapi-rest">();
  });

  it("declares this driver's branded handler type as the slot", () => {
    type Driver = ReturnType<typeof openapiRest>;
    expectTypeOf<HandlerOf<Driver>>().toEqualTypeOf<OpenApiRestHandler>();
  });

  it("rejects a misspelled driver field", () => {
    // @ts-expect-error `spce` is not a driver field
    openapiRest({ spce: SPEC });
  });

  it("declares the HTTP operation fields", () => {
    type Driver = ReturnType<typeof openapiRest>;
    expectTypeOf<
      OperationFields<Driver>
    >().toEqualTypeOf<OpenApiRestOperationFields>();
  });
});

describe("openapiRest with defineGateway", () => {
  it("preserves literal operation keys and the upstream field", () => {
    const gw = defineGateway({
      id: "test",
      driver: openapiRest({ spec: SPEC }),
      operations: {
        createUser: { upstream: "POST /v1/user" },
        getAddress: {
          upstream: "GET /addresses/{uprn}",
          parameters: {
            propertyRef: { in: "path", name: "uprn" },
            format: { in: "query" },
            requestId: { in: "header", name: "x-request-id" },
          },
        },
      },
    });

    expectTypeOf<keyof typeof gw.operations>().toEqualTypeOf<
      "createUser" | "getAddress"
    >();
    expect(gw.operations.createUser.upstream).toBe("POST /v1/user");
    expect(gw.operations.getAddress.parameters?.format).toEqual({
      in: "query",
    });
    expect(gw.driver.spec).toBe(SPEC);
  });

  it("rejects operations without an upstream", () => {
    defineGateway({
      id: "test",
      driver: openapiRest({ spec: SPEC }),
      operations: {
        // @ts-expect-error upstream is required by the openapi-rest driver
        missing: { description: "No upstream" },
      },
    });
  });

  it("rejects an unknown parameter location", () => {
    defineGateway({
      id: "test",
      driver: openapiRest({ spec: SPEC }),
      operations: {
        op: {
          upstream: "GET /x",
          // @ts-expect-error cookie parameters are not supported
          parameters: { session: { in: "cookie" } },
        },
      },
    });
  });

  it("rejects an upstream with an unknown method or no leading slash", () => {
    defineGateway({
      id: "test",
      driver: openapiRest({ spec: SPEC }),
      operations: {
        // @ts-expect-error FETCH is not an HTTP method the driver supports
        badMethod: { upstream: "FETCH /x" },
        // @ts-expect-error the path must start with a slash
        badPath: { upstream: "GET x" },
      },
    });
  });
});
