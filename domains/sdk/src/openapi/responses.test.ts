import { describe, expect, it } from "vitest";

import { PLATFORM_ERROR_SCHEMA, responsesOf } from "./responses.ts";
import type { JsonSchema } from "./types.ts";

const PLATFORM_ERROR_REF = { $ref: "#/components/schemas/PlatformError" };

const OWN: JsonSchema = { type: "object", properties: { code: {} } };

function responses(
  declared: Record<number, JsonSchema | null>,
  takesBody = false,
) {
  return responsesOf(
    new Map(
      Object.entries(declared).map(([status, schema]) => [
        Number(status),
        schema,
      ]),
    ),
    takesBody,
  );
}

describe("PLATFORM_ERROR_SCHEMA", () => {
  it("allows only the types the SDK sends", () => {
    expect(PLATFORM_ERROR_SCHEMA).toEqual({
      type: "object",
      properties: {
        message: { type: "string" },
        type: { enum: ["client_error", "server_error"] },
      },
      required: ["message", "type"],
      additionalProperties: false,
    });
  });
});

describe("responsesOf", () => {
  it("describes each declared response by its status's name, with its body or none", () => {
    const described = responses({ 200: OWN, 204: null, 404: null });

    expect(described[200]).toEqual({
      description: "OK",
      content: { "application/json": { schema: OWN } },
    });
    expect(described[204]).toEqual({ description: "No content" });
    expect(described[404]).toEqual({ description: "Not found" });
  });

  it.each<[boolean, readonly string[]]>([
    [false, ["200", "400", "500", "502", "503", "504"]],
    [true, ["200", "400", "415", "500", "502", "503", "504"]],
  ])(
    "adds what the SDK answers on any route, 415 only with a body (takes a body: %s)",
    (takesBody, statuses) => {
      expect(Object.keys(responses({ 200: OWN }, takesBody))).toEqual(statuses);
    },
  );

  it("describes an undeclared response with the platform's failure body", () => {
    expect(responses({ 200: OWN })[504]).toEqual({
      description: "Gateway timeout",
      content: { "application/json": { schema: PLATFORM_ERROR_REF } },
    });
  });

  it.each<[JsonSchema | null, string, JsonSchema]>([
    [OWN, "Bad request, from the route", { anyOf: [OWN, PLATFORM_ERROR_REF] }],
    [null, "Bad request, from the route with no body", PLATFORM_ERROR_REF],
  ])(
    "describes a route's own 400 beside the SDK's",
    (own, description, schema) => {
      expect(responses({ 200: OWN, 400: own })[400]).toEqual({
        description: `${description}, or from the SDK`,
        content: { "application/json": { schema } },
      });
    },
  );
});
