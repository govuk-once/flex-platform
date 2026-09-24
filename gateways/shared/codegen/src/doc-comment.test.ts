import ts from "typescript";
import { describe, expect, it } from "vitest";

import { docComment, documentationOf } from "./doc-comment.ts";

// What the compiler makes of a comment written in front of a field: the declarations it found,
// and the tags it read. Text that escaped the comment shows up as a declaration of its own.
function compiled(comment: string) {
  const source = ts.createSourceFile(
    "doc.ts",
    `export type T = { ${comment}readonly field: string };`,
    ts.ScriptTarget.Latest,
    true,
  );
  const diagnostics = (
    source as unknown as { parseDiagnostics: readonly unknown[] }
  ).parseDiagnostics;
  const [statement] = source.statements;
  const member =
    statement !== undefined && ts.isTypeAliasDeclaration(statement)
      ? (statement.type as ts.TypeLiteralNode).members[0]
      : undefined;
  return {
    statements: source.statements.length,
    parseErrors: diagnostics.length,
    members:
      statement !== undefined && ts.isTypeAliasDeclaration(statement)
        ? (statement.type as ts.TypeLiteralNode).members.length
        : 0,
    tags:
      member === undefined
        ? []
        : ts.getJSDocTags(member).map((tag) => tag.tagName.text),
  };
}

// What declaration emission makes of the same comments. `stripInternal` reads the comment text
// rather than the tags the parser found, and removes the declaration it marks: one taken out
// while what refers to it stays leaves a `.d.ts` naming a type it no longer declares.
//
// Every comment is emitted in one program, each in a file and under names of its own: a program
// reads the standard library as it is created, which is the whole cost of this file, and one
// case per program pays it again for each.
function emitted(comments: readonly string[]): string[] {
  const files = comments.map((comment, index) => ({
    name: `/doc${index}.ts`,
    text: `${comment}export type Thing${index} = { readonly id: string };\nexport type Held${index} = { readonly thing: Thing${index} };\n`,
  }));
  const host = ts.createCompilerHost({});
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.readFile = (name) =>
    files.find((file) => file.name === name)?.text ?? read(name);
  host.fileExists = (name) =>
    files.some((file) => file.name === name) || exists(name);
  const written = new Map<string, string>();
  host.writeFile = (name, data) => {
    written.set(name, data);
  };
  ts.createProgram(
    files.map((file) => file.name),
    {
      declaration: true,
      emitDeclarationOnly: true,
      stripInternal: true,
      types: [],
    },
    host,
  ).emit();
  return files.map(
    (file) => written.get(file.name.replace(/\.ts$/, ".d.ts")) ?? "",
  );
}

// The descriptions a comment must not let strip the declaration it is written in front of, and,
// last, the tag written as one that must strip it.
const STRIPPING = [
  "@internal",
  "Fine.\n@internal",
  "a @internal b",
  "\\@internal",
];
const WRITTEN_TAG = "\n/** @internal */\n";

const declarations = emitted([
  ...STRIPPING.map((description) => docComment({ description })),
  WRITTEN_TAG,
]);

describe("docComment", () => {
  it("writes nothing when there is nothing to say", () => {
    expect(docComment({})).toBe("");
    expect(docComment({ description: "  \n " })).toBe("");
  });

  it("writes one line as one line, and several as a block", () => {
    expect(docComment({ description: "The user's id" })).toBe(
      "\n/** The user's id */\n",
    );
    expect(docComment({ description: "First\r\nSecond\n\nFourth  " })).toBe(
      "\n/**\n * First\n * Second\n *\n * Fourth\n */\n",
    );
  });

  it("marks what the schema marks as deprecated, and nothing else", () => {
    expect(docComment({ deprecated: true })).toBe("\n/** @deprecated */\n");
    expect(docComment({ description: "Old", deprecated: true })).toBe(
      "\n/**\n * Old\n * @deprecated\n */\n",
    );
    expect(
      compiled(docComment({ description: "Old", deprecated: true })).tags,
    ).toEqual(["deprecated"]);
  });

  it.each([
    ["ends the comment", "fine */ readonly injected: true; /* "],
    [
      "ends the comment on a later line",
      "fine\n*/ readonly injected: true; /*",
    ],
    ["ends it twice over", "a **/ b */ c"],
    ["ends it with nothing else", "*/"],
  ])("keeps text that %s inside the comment", (_what, description) => {
    const result = compiled(docComment({ description }));

    expect(result).toEqual({
      statements: 1,
      parseErrors: 0,
      members: 1,
      tags: [],
    });
  });

  it("reads a tag written as one, so the cases below are not passing for want of looking", () => {
    expect(compiled("\n/** @deprecated */\n").tags).toEqual(["deprecated"]);
    expect(compiled("\n/**\n * Fine.\n * @internal\n */\n").tags).toEqual([
      "internal",
    ]);
  });

  it.each([
    ["at the start", "@deprecated use something else"],
    ["on a later line", "Fine.\n@internal"],
    ["after spaces", "Fine.\n   @deprecated"],
    ["part way along a line", "Ordinary text @deprecated"],
    ["with words either side", "a @internal b"],
    ["behind a star of its own", "* @internal"],
    ["behind an escaped terminator", "Fine. */ @internal"],
  ])("does not let text %s write a tag", (_what, description) => {
    expect(compiled(docComment({ description })).tags).toEqual([]);
  });

  it("writes an @ as a reference, which renders as one and parses as nothing", () => {
    expect(docComment({ description: "Mail someone@example.test" })).toBe(
      "\n/** Mail someone&#64;example.test */\n",
    );
  });

  it.each(STRIPPING.map((description, index) => [description, index] as const))(
    "keeps the declaration a description of %j would have stripped",
    (_description, index) => {
      // A backslash stops the parser reading the tag and does not stop `stripInternal`, so the
      // declarations are what says this holds: emitting one that referred to a type removed from
      // under it is the failure, and it compiles right up until a caller uses it.
      const output = declarations[index];

      expect(output).toContain(`export type Thing${index}`);
      expect(output).toContain(`export type Held${index}`);
    },
  );

  it("strips on a tag it wrote, so the cases above are not passing for want of looking", () => {
    const output = declarations[STRIPPING.length];

    // What the case is emitted with, so an output that was never written is not read as a strip.
    expect(output).toContain(`export type Held${STRIPPING.length}`);
    expect(output).not.toContain("export type Thing");
  });
});

describe("documentationOf", () => {
  it("reads the description, and the title only where there is none", () => {
    expect(
      documentationOf({ description: "Says more", title: "Label" }),
    ).toEqual({ description: "Says more" });
    expect(documentationOf({ title: "Label" })).toEqual({
      description: "Label",
    });
    expect(documentationOf({ description: 42, deprecated: "yes" })).toEqual({});
    expect(documentationOf({ deprecated: true })).toEqual({ deprecated: true });
    expect(documentationOf(true)).toEqual({});
  });
});
