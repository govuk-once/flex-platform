import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { HandlerOf, OperationFields } from "@repo/gateway-config";
import { defineGateway } from "@repo/gateway-config";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { OpenApiRestHandler } from "../types.ts";
import { OPENAPI_REST_DRIVER_TYPE } from "../types.ts";
import { noAuth } from "./auth.ts";
import type { OpenApiRestOperationFields } from "./definition.ts";
import { openapiRest } from "./definition.ts";

const SPEC = "https://example.test/openapi.yml";
const AUTH = noAuth();

const METADATA = {
  upstreamRequestId: { header: "X-Request-Id", schema: { type: "string" } },
};

describe("openapiRest", () => {
  it("builds a driver definition naming its type, spec and auth", () => {
    const definition = openapiRest({ spec: SPEC, auth: AUTH });
    expect(definition).toMatchObject({
      type: OPENAPI_REST_DRIVER_TYPE,
      spec: SPEC,
      auth: AUTH,
    });
    expect(Object.keys(definition)).toEqual([
      "type",
      "createExecutor",
      "checkSchemas",
      "deriveSchemasModule",
      "spec",
      "auth",
    ]);
  });

  it("gives the module that derives its schemas as a file: URL to its own derive/", () => {
    // A URL and not an import: what the module needs to read an OpenAPI document must not
    // follow the definition into a deployed gateway.
    const { deriveSchemasModule } = openapiRest({ spec: SPEC, auth: AUTH });
    const url = new URL(deriveSchemasModule ?? "");

    expect(url.protocol).toBe("file:");
    expect(url.pathname.endsWith("/src/derive/index.ts")).toBe(true);
    expect(existsSync(fileURLToPath(url))).toBe(true);
  });

  it("carries headers and the response limit when given", () => {
    const definition = openapiRest({
      spec: SPEC,
      auth: AUTH,
      headers: { "x-api-version": "2" },
      maxResponseBytes: 4096,
      metadata: METADATA,
    });
    expect(definition).toMatchObject({
      type: OPENAPI_REST_DRIVER_TYPE,
      spec: SPEC,
      auth: AUTH,
      headers: { "x-api-version": "2" },
      maxResponseBytes: 4096,
      metadata: METADATA,
    });
    expect(Object.keys(definition)).toEqual([
      "type",
      "createExecutor",
      "checkSchemas",
      "deriveSchemasModule",
      "spec",
      "auth",
      "headers",
      "maxResponseBytes",
      "metadata",
    ]);
  });

  it("requires an auth definition", () => {
    // @ts-expect-error every gateway states how its requests are authenticated
    const definition = openapiRest({ spec: SPEC });
    expect(definition.auth).toBeUndefined();
  });

  it("types the driver with a literal type discriminator", () => {
    const driver = openapiRest({ spec: SPEC, auth: AUTH });
    expectTypeOf(driver.type).toEqualTypeOf<"openapi-rest">();
  });

  it("declares this driver's branded handler type as the slot", () => {
    type Driver = ReturnType<typeof openapiRest>;
    expectTypeOf<HandlerOf<Driver>>().toEqualTypeOf<OpenApiRestHandler>();
  });

  it("rejects a misspelled driver field", () => {
    // @ts-expect-error `spce` is not a driver field
    const definition = openapiRest({ spec: SPEC, auth: AUTH, spce: SPEC });
    expect(Object.keys(definition)).not.toContain("spce");
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
      driver: openapiRest({ spec: SPEC, auth: AUTH }),
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
    const gw = defineGateway({
      id: "test",
      driver: openapiRest({ spec: SPEC, auth: AUTH }),
      operations: {
        // @ts-expect-error upstream is required by the openapi-rest driver
        missing: { description: "No upstream" },
      },
    });
    // The requirement is a type-level one; defineGateway passes the operation through.
    expect(gw.operations.missing).toEqual({ description: "No upstream" });
  });

  it("rejects an unknown parameter location", () => {
    const gw = defineGateway({
      id: "test",
      driver: openapiRest({ spec: SPEC, auth: AUTH }),
      operations: {
        op: {
          upstream: "GET /x",
          // @ts-expect-error cookie parameters are not supported
          parameters: { session: { in: "cookie" } },
        },
      },
    });
    expect(gw.operations).toMatchObject({
      op: { parameters: { session: { in: "cookie" } } },
    });
  });

  it("rejects an upstream with an unknown method or no leading slash", () => {
    const gw = defineGateway({
      id: "test",
      driver: openapiRest({ spec: SPEC, auth: AUTH }),
      operations: {
        // @ts-expect-error FETCH is not an HTTP method the driver supports
        badMethod: { upstream: "FETCH /x" },
        // @ts-expect-error the path must start with a slash
        badPath: { upstream: "GET x" },
      },
    });
    // Nothing parses the template at runtime, so both survive as written.
    expect(gw.operations).toMatchObject({
      badMethod: { upstream: "FETCH /x" },
      badPath: { upstream: "GET x" },
    });
  });
});
