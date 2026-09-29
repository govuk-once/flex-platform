import { defineGateway } from "@repo/gateway-config";
import { describe, expect, expectTypeOf, it } from "vitest";

import { openapiRest, type UpstreamTemplate } from "./definition.ts";
import type { PathParameters, RefineOpenApiRestOperation } from "./refine.ts";

const DRIVER = openapiRest({
  spec: "https://example.test/openapi.yml",
  auth: [],
});

describe("PathParameters", () => {
  it("extracts every template parameter", () => {
    expectTypeOf<PathParameters<"GET /a/{x}/b/{y}.json">>().toEqualTypeOf<
      "x" | "y"
    >();
    expectTypeOf<PathParameters<"GET /a">>().toEqualTypeOf<never>();
    expectTypeOf<PathParameters<string>>().toEqualTypeOf<never>();
  });
});

describe("RefineOpenApiRestOperation", () => {
  it("is the identity when every parameter is declared", () => {
    type Op = {
      readonly upstream: "GET /users/{id}";
      readonly parameters: { readonly id: { readonly in: "path" } };
    };
    expectTypeOf<RefineOpenApiRestOperation<Op>>().toEqualTypeOf<Op>();
  });

  it("accepts a renamed parameter", () => {
    type Op = {
      readonly upstream: "GET /users/{id}";
      readonly parameters: {
        readonly userId: { readonly in: "path"; readonly name: "id" };
      };
    };
    expectTypeOf<RefineOpenApiRestOperation<Op>>().toEqualTypeOf<Op>();
  });

  it("requires the missing parameter", () => {
    type Op = { readonly upstream: "GET /users/{id}" };
    expectTypeOf<RefineOpenApiRestOperation<Op>>().not.toEqualTypeOf<Op>();
    expectTypeOf<RefineOpenApiRestOperation<Op>>().toHaveProperty("parameters");
  });

  it("is not the identity when a path entry names a parameter the template lacks", () => {
    type Renamed = {
      readonly upstream: "GET /users/{id}";
      readonly parameters: {
        readonly id: { readonly in: "path"; readonly name: "nope" };
      };
    };
    expectTypeOf<
      RefineOpenApiRestOperation<Renamed>
    >().not.toEqualTypeOf<Renamed>();

    type Extra = {
      readonly upstream: "GET /users/{id}";
      readonly parameters: {
        readonly id: { readonly in: "path" };
        readonly f: { readonly in: "path"; readonly name: "nope" };
      };
    };
    expectTypeOf<
      RefineOpenApiRestOperation<Extra>
    >().not.toEqualTypeOf<Extra>();
  });
});

describe("RefineOpenApiRestOperation with a non-literal template", () => {
  it("defers template checks and keeps the mapping-key check", () => {
    type Declared = {
      readonly upstream: UpstreamTemplate;
      readonly parameters: { readonly id: { readonly in: "path" } };
    };
    expectTypeOf<
      RefineOpenApiRestOperation<Declared>
    >().toEqualTypeOf<Declared>();

    type Typo = {
      readonly upstream: UpstreamTemplate;
      readonly parameters: {
        readonly id: { readonly in: "path"; readonly nmae: "x" };
      };
    };
    expectTypeOf<RefineOpenApiRestOperation<Typo>>().not.toEqualTypeOf<Typo>();
  });

  it("lets a helper build operations from a template parameter", () => {
    function withTemplate(upstream: UpstreamTemplate) {
      return defineGateway({
        id: "test",
        driver: DRIVER,
        operations: {
          op: { upstream, parameters: { id: { in: "path" } } },
        },
      });
    }
    expect(withTemplate("GET /users/{id}").operations.op.upstream).toBe(
      "GET /users/{id}",
    );
  });
});

describe("defineGateway with the openapi-rest refinement", () => {
  it("accepts declared and renamed path parameters", () => {
    const gw = defineGateway({
      id: "test",
      driver: DRIVER,
      operations: {
        noParams: { upstream: "POST /v1/user" },
        declared: {
          upstream: "GET /users/{id}",
          parameters: { id: { in: "path" } },
        },
        renamed: {
          upstream: "GET /orgs/{orgId}/users/{id}",
          parameters: {
            orgId: { in: "path" },
            userId: { in: "path", name: "id" },
          },
        },
      },
    });
    expect(gw.operations.renamed.parameters?.userId).toEqual({
      in: "path",
      name: "id",
    });
    expectTypeOf<keyof typeof gw.operations>().toEqualTypeOf<
      "noParams" | "declared" | "renamed"
    >();
  });

  it("rejects a template parameter without an entry", () => {
    const gw = defineGateway({
      id: "test",
      driver: DRIVER,
      operations: {
        // The error lands on the operation when parameters is absent, and on parameters
        // when it is present but incomplete.
        // @ts-expect-error {id} has no parameters entry
        missing: { upstream: "POST /v1/user/{id}" },
        partial: {
          upstream: "GET /orgs/{orgId}/users/{id}",
          // @ts-expect-error {orgId} has no parameters entry
          parameters: { id: { in: "path" } },
        },
        elsewhere: {
          upstream: "GET /users/{id}",
          // @ts-expect-error id is sent as a query parameter, so {id} is unfilled
          parameters: { id: { in: "query" } },
        },
      },
    });
    expectTypeOf<keyof typeof gw.operations>().toEqualTypeOf<
      "missing" | "partial" | "elsewhere"
    >();
    // The refinement is a type-level check; the operations pass through as written.
    expect(gw.operations.elsewhere.parameters).toEqual({ id: { in: "query" } });
  });

  it("rejects misspelled keys in operations and parameter mappings", () => {
    const gw = defineGateway({
      id: "test",
      driver: DRIVER,
      operations: {
        mapping: {
          upstream: "GET /users/{id}",
          // @ts-expect-error `nmae` is not a parameter mapping key
          parameters: { id: { in: "path", nmae: "id" } },
        },
        operation: {
          upstream: "GET /users",
          // @ts-expect-error `paramters` is not an operation field
          paramters: {},
        },
        handler: {
          upstream: "GET /users",
          // @ts-expect-error `hanlder` is not an operation field
          hanlder: () => Promise.resolve({ outcome: "ok", data: null }),
        },
      },
    });
    expectTypeOf<keyof typeof gw.operations>().toEqualTypeOf<
      "mapping" | "operation" | "handler"
    >();
    expect(gw.operations.mapping.parameters).toEqual({
      id: { in: "path", nmae: "id" },
    });
  });

  it("rejects a path entry that names a parameter the template lacks", () => {
    const gw = defineGateway({
      id: "test",
      driver: DRIVER,
      operations: {
        renamedAway: {
          upstream: "GET /users/{id}",
          // @ts-expect-error the key matches {id} but name points it at "nope"
          parameters: { id: { in: "path", name: "nope" } },
        },
        extraEntry: {
          upstream: "GET /users/{id}",
          // @ts-expect-error f names "nope", which is not in the template
          parameters: { id: { in: "path" }, f: { in: "path", name: "nope" } },
        },
        extraKey: {
          upstream: "GET /users/{id}",
          // @ts-expect-error other is not in the template and {id} is unfilled
          parameters: { id: { in: "path" }, other: { in: "path" } },
        },
        noTemplateParams: {
          upstream: "GET /users",
          // @ts-expect-error the template has no parameters to fill
          parameters: { id: { in: "path" } },
        },
      },
    });
    expectTypeOf<keyof typeof gw.operations>().toEqualTypeOf<
      "renamedAway" | "extraEntry" | "extraKey" | "noTemplateParams"
    >();
    expect(gw.operations.renamedAway.parameters).toEqual({
      id: { in: "path", name: "nope" },
    });
  });
});
