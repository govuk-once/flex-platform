import { describe, expect, it } from "vitest";

import { lowerCaseHeaders, mediaType, traceRoot } from "./http.ts";

describe("lowerCaseHeaders", () => {
  it("lowers every name and keeps every value", () => {
    expect(
      lowerCaseHeaders({ "Content-Type": "application/json", "X-A": "B" }),
    ).toEqual({ "content-type": "application/json", "x-a": "B" });
  });
});

describe("mediaType", () => {
  it("drops the parameters and the case", () => {
    expect(mediaType("Application/JSON; charset=utf-8")).toBe(
      "application/json",
    );
    expect(mediaType(undefined)).toBeUndefined();
  });
});

describe("traceRoot", () => {
  it("reads the root among the trace header's fields", () => {
    expect(
      traceRoot(
        "Self=1-abc;Root=1-5759e988-bd862e3fe1be46a994272793;Sampled=1",
      ),
    ).toBe("1-5759e988-bd862e3fe1be46a994272793");
  });

  it("is undefined without a root", () => {
    expect(traceRoot("Sampled=1")).toBeUndefined();
    expect(traceRoot("Root=")).toBeUndefined();
    expect(traceRoot(undefined)).toBeUndefined();
  });
});
