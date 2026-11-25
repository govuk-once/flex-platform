import { assert, describe, expect, it } from "vitest";
import { z } from "zod";

import { parameterTypes } from "../input-rules.ts";
import { createParameterReader } from "./parameter-reader.ts";

const Query = z.strictObject({
  tag: z.array(z.string()).optional(),
  page: z.number().optional(),
  done: z.boolean().optional(),
  sort: z.enum(["title", "due"]).optional(),
});

function readerFor(schema: z.ZodObject, location: "path" | "query") {
  const result = parameterTypes(schema, location);

  assert(result.ok);

  return createParameterReader(result.types);
}

const read = readerFor(Query, "query");

const readQuery = (sent: Record<string, string | readonly string[]>) =>
  read(new Map(Object.entries(sent)));

describe("createParameterReader", () => {
  it("reads each parameter as its type, and one sent once but repeatable as a list", () => {
    expect(
      readQuery({ tag: "a", page: "2", done: "false", sort: "due" }),
    ).toEqual({ tag: ["a"], page: 2, done: false, sort: "due" });
    expect(readQuery({ tag: ["a", "b"] })).toEqual({ tag: ["a", "b"] });
  });

  it.each([
    ["0", 0],
    ["7", 7],
    ["-12", -12],
    ["2.5", 2.5],
    ["-0.25", -0.25],
    ["9007199254740991", 9_007_199_254_740_991],
  ])("reads %j as a number", (text, number) => {
    expect(readQuery({ page: text })).toEqual({ page: number });
  });

  it.each([
    "",
    " 7",
    "7 ",
    "+7",
    "007",
    "1e3",
    "0x10",
    "0b1",
    ".5",
    "5.",
    "-0",
    "Infinity",
    "NaN",
    "1_000",
    "9007199254740993",
    "1".repeat(400),
  ])("leaves %j as text for a number schema to refuse", (text) => {
    expect(readQuery({ page: text })).toEqual({ page: text });
  });

  it.each([
    ["true", true],
    ["false", false],
  ])("reads %j as a boolean", (text, boolean) => {
    expect(readQuery({ done: text })).toEqual({ done: boolean });
  });

  it.each(["", "1", "0", "yes", "off", "TRUE", "False"])(
    "leaves %j as text for a boolean schema to refuse",
    (text) => {
      expect(readQuery({ done: text })).toEqual({ done: text });
    },
  );

  it("leaves a string as it is", () => {
    expect(readQuery({ tag: "007" })).toEqual({ tag: ["007"] });
  });

  it("leaves what it cannot read for the schema to refuse", () => {
    const values = readQuery({ page: ["2", "3"], done: "yes", other: "1" });

    expect(values).toEqual({ page: ["2", "3"], done: "yes", other: "1" });
    expect(Query.safeParse(values).success).toBe(false);
  });

  it("gives the schema values it validates, with no field the request did not send", () => {
    const values = readQuery({ page: "2" });

    expect(Query.parse(values)).toEqual({ page: 2 });
    expect(Object.getPrototypeOf(values)).toBeNull();
  });

  it("reads path parameters, which are never repeated", () => {
    const readPath = readerFor(z.object({ id: z.int() }), "path");

    expect(readPath(new Map([["id", "7"]]))).toEqual({ id: 7 });
  });
});
