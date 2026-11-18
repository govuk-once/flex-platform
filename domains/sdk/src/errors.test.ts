import { sortedNames } from "@repo/utils/sorted-names";
import { describe, expect, it } from "vitest";

import {
  ErrorBodySchema,
  ERRORS,
  HANDLER_REJECTION_CODES,
  PIPELINE_ERROR_CODES,
  ROUTE_REJECTION_CODES,
} from "./errors.ts";

describe("ERRORS", () => {
  it("types each code by its status", () => {
    for (const { status, type } of Object.values(ERRORS)) {
      const expected =
        status === 401 || status === 403
          ? "auth_error"
          : status < 500
            ? "client_error"
            : "server_error";

      expect(type).toBe(expected);
    }
  });

  it("gives each code its own status", () => {
    const statuses = Object.values(ERRORS).map(({ status }) => status);

    expect(new Set(statuses).size).toBe(statuses.length);
  });

  it("places every code in exactly one of the route, handler or pipeline groups", () => {
    const grouped = [
      ...ROUTE_REJECTION_CODES,
      ...HANDLER_REJECTION_CODES,
      ...PIPELINE_ERROR_CODES,
    ];

    expect(sortedNames(grouped)).toEqual(sortedNames(Object.keys(ERRORS)));
  });
});

describe("ErrorBodySchema", () => {
  it("accepts the body of every code", () => {
    for (const [code, { type, message }] of Object.entries(ERRORS)) {
      expect(ErrorBodySchema.safeParse({ message, type, code }).success).toBe(
        true,
      );
    }
  });

  it("refuses a code outside the catalogue", () => {
    expect(
      ErrorBodySchema.safeParse({
        message: "Teapot",
        type: "client_error",
        code: "teapot",
      }).success,
    ).toBe(false);
  });
});
