import { describe, expect, it } from "vitest";
import { z } from "zod";

import { strictInputProblems } from "./strict-input.ts";

const problem = (at: string) =>
  `${at}: an object that names its fields refuses any other, so declare it with z.strictObject`;

describe("strictInputProblems", () => {
  it("takes a strict object, and one picked or extended from it", () => {
    const Todo = z.strictObject({ id: z.string(), title: z.string() });

    expect(strictInputProblems(Todo, "body")).toEqual([]);
    expect(strictInputProblems(Todo.pick({ title: true }), "body")).toEqual([]);
    expect(
      strictInputProblems(Todo.extend({ done: z.boolean() }), "body"),
    ).toEqual([]);
  });

  it.each([
    ["z.object", z.object({ id: z.string() })],
    ["z.looseObject", z.looseObject({ id: z.string() })],
    ["a catchall", z.object({ id: z.string() }).catchall(z.string())],
  ])("refuses an object made with %s", (_case, schema) => {
    expect(strictInputProblems(schema, "body")).toEqual([problem("body")]);
  });

  it("finds an open object wherever the input holds one, by its location", () => {
    // A new object each time, since an object met again is not read twice.
    const open = () => z.object({ id: z.string() });

    const body = z.strictObject({
      owner: open().optional(),
      tags: z.array(open()).nullable(),
      labels: z.record(z.string(), open()),
      pair: z.tuple([open()], open()),
      either: z.union([z.null(), open()]),
      parsed: open().transform(({ id }) => id),
      later: z.lazy(open).default({ id: "1" }),
    });

    expect(strictInputProblems(body, "body")).toEqual([
      problem("body.owner"),
      problem("body.tags[]"),
      problem("body.labels[*]"),
      problem("body.pair[0]"),
      problem("body.pair[]"),
      problem("body.either"),
      problem("body.parsed"),
      problem("body.later"),
    ]);
  });

  it("leaves open an object that names no field, and each side of an intersection", () => {
    const body = z.strictObject({
      metadata: z.object({}),
      labels: z.record(z.string(), z.string()),
      when: z.intersection(
        z.object({ from: z.string() }),
        z.object({ to: z.string() }),
      ),
    });

    expect(strictInputProblems(body, "body")).toEqual([]);
  });

  it("follows a recursive schema to its end", () => {
    const Node = z.strictObject({
      name: z.string(),
      get children() {
        return z.array(Node);
      },
    });

    expect(strictInputProblems(Node, "body")).toEqual([]);
  });
});
