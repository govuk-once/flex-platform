import { describe, expect, it } from "vitest";

import { parseDuration } from "./duration.ts";

describe("parseDuration", () => {
  it("parses seconds", () => {
    expect(parseDuration("10s")).toBe(10_000);
  });

  it("parses milliseconds", () => {
    expect(parseDuration("500ms")).toBe(500);
  });

  it("parses minutes", () => {
    expect(parseDuration("2m")).toBe(120_000);
  });

  it("parses fractional seconds", () => {
    expect(parseDuration("1.5s")).toBe(1_500);
  });

  it("parses zero", () => {
    expect(parseDuration("0s")).toBe(0);
  });

  it("rejects bare number", () => {
    expect(() => parseDuration("10")).toThrow("Invalid duration");
  });

  it("rejects empty string", () => {
    expect(() => parseDuration("")).toThrow("Invalid duration");
  });

  it("rejects unknown unit", () => {
    expect(() => parseDuration("10x")).toThrow("Invalid duration");
  });

  it("rejects negative", () => {
    expect(() => parseDuration("-5s")).toThrow("Invalid duration");
  });

  it("rejects whitespace", () => {
    expect(() => parseDuration("  ")).toThrow("Invalid duration");
  });

  it("rejects space between number and unit", () => {
    expect(() => parseDuration("10 s")).toThrow("Invalid duration");
  });
});
