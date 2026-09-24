import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SCHEMAS_DIR } from "./layout.ts";
import {
  loadVersions,
  readSchemas,
  SchemaStoreError,
  schemaVersions,
} from "./schema-store.ts";

const schemasOf = (outcome: string) => ({
  operations: {
    op: {
      input: { type: "object" },
      outcomes: { [outcome]: { type: "null" } },
    },
  },
});

let gatewayDir: string;

beforeEach(async () => {
  gatewayDir = await mkdtemp(path.join(os.tmpdir(), "schema-store-"));
  await mkdir(path.join(gatewayDir, SCHEMAS_DIR));
});

afterEach(async () => {
  await rm(gatewayDir, { recursive: true, force: true });
});

const inStore = (name: string) => path.join(gatewayDir, SCHEMAS_DIR, name);

async function writeVersion(version: string, content: unknown): Promise<void> {
  await writeFile(
    inStore(`${version}.json`),
    typeof content === "string" ? content : JSON.stringify(content),
  );
}

async function problemsOf(run: Promise<unknown>): Promise<readonly string[]> {
  const error: unknown = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SchemaStoreError);
  return (error as SchemaStoreError).problems;
}

describe("schemaVersions", () => {
  it("lists the versions oldest first, however the directory lists them", async () => {
    for (const version of ["0003", "0001", "0002"]) {
      await writeVersion(version, schemasOf("ok"));
    }

    await expect(schemaVersions(gatewayDir)).resolves.toEqual([
      "0001",
      "0002",
      "0003",
    ]);
  });

  it("leaves out what an editor or an operating system leaves behind", async () => {
    await writeVersion("0001", schemasOf("ok"));
    await writeFile(inStore(".DS_Store"), "");

    await expect(schemaVersions(gatewayDir)).resolves.toEqual(["0001"]);
  });

  it("refuses a gateway with no schemas directory, and says where a version goes", async () => {
    await rm(path.join(gatewayDir, SCHEMAS_DIR), { recursive: true });

    const [problem] = await problemsOf(schemaVersions(gatewayDir));
    expect(problem).toContain("schemas/0001.json");
  });

  it("refuses a directory that holds no versions", async () => {
    expect(await problemsOf(schemaVersions(gatewayDir))).toEqual([
      "holds no versions; the first is 0001.json",
    ]);
  });

  it("refuses anything that is not a version, naming each", async () => {
    // A name that is nearly a version is the likeliest mistake, and reading around it would
    // generate from a version the author did not mean to be the latest.
    await writeVersion("0001", schemasOf("ok"));
    await writeFile(inStore("2.json"), "{}");
    await writeFile(inStore("00003.json"), "{}");
    await writeFile(inStore("notes.md"), "");
    await mkdir(inStore("0002.json"));

    const problems = await problemsOf(schemaVersions(gatewayDir));
    expect(problems).toHaveLength(4);
    for (const name of ["2.json", "00003.json", "notes.md", "0002.json"]) {
      expect(problems.join("\n")).toContain(`"${name}" is not a version`);
    }
  });

  it("refuses a gap in the numbering, naming the version left out", async () => {
    await writeVersion("0001", schemasOf("ok"));
    await writeVersion("0003", schemasOf("ok"));

    const [problem] = await problemsOf(schemaVersions(gatewayDir));
    expect(problem).toContain("0002.json is missing");
  });

  it("refuses numbering that does not start at the first version", async () => {
    await writeVersion("0002", schemasOf("ok"));

    const [problem] = await problemsOf(schemaVersions(gatewayDir));
    expect(problem).toContain("0001.json is missing");
  });
});

describe("readSchemas", () => {
  it("reads a version as it is on disk each time", async () => {
    await writeVersion("0001", schemasOf("ok"));
    await expect(readSchemas(gatewayDir, "0001")).resolves.toEqual(
      schemasOf("ok"),
    );

    await writeVersion("0001", schemasOf("created"));
    await expect(readSchemas(gatewayDir, "0001")).resolves.toEqual(
      schemasOf("created"),
    );
  });

  it("accepts shared definitions beside the operations", async () => {
    const schemas = { defs: { Thing: { type: "object" } }, ...schemasOf("ok") };
    await writeVersion("0001", schemas);

    await expect(readSchemas(gatewayDir, "0001")).resolves.toEqual(schemas);
  });

  it("refuses a version that is not JSON, naming the file", async () => {
    await writeVersion("0001", "export default {};");

    const error: unknown = await readSchemas(gatewayDir, "0001").catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(SchemaStoreError);
    expect((error as Error).message).toContain(inStore("0001.json"));
    expect((error as Error).message).toContain("cannot be read as JSON");
  });

  it("refuses a version that is not an object", async () => {
    await writeVersion("0001", "[]");

    expect(await problemsOf(readSchemas(gatewayDir, "0001"))).toEqual([
      "must be a JSON object",
    ]);
  });

  it("reports everything wrong with a version's shape in one run", async () => {
    await writeVersion("0001", {
      definitions: {},
      defs: { Thing: true },
      operations: {
        bare: "not an object",
        noInput: { outcomes: { ok: { type: "null" } } },
        noOutcomes: { input: { type: "object" } },
        extra: {
          input: { type: "object" },
          outcomes: { ok: { type: "null" }, broken: [] },
          output: {},
        },
      },
    });

    expect(await problemsOf(readSchemas(gatewayDir, "0001"))).toEqual([
      'the version has an unknown field "definitions"; expected "defs" and "operations"',
      "defs.Thing must be a schema object",
      "operations.bare must be an object",
      "operations.noInput.input must be a schema object",
      "operations.noOutcomes.outcomes must be an object of schemas",
      'operations.extra has an unknown field "output"; expected "input" and "outcomes"',
      "operations.extra.outcomes.broken must be a schema object",
    ]);
  });

  it("refuses a version whose parts are not objects of schemas", async () => {
    await writeVersion("0001", { defs: [], operations: [] });

    expect(await problemsOf(readSchemas(gatewayDir, "0001"))).toEqual([
      '"defs" must be an object of schemas',
      '"operations" must be an object of operations',
    ]);
  });

  it("refuses a name an object would read as its prototype", async () => {
    // Written as text: JSON.parse makes the key an ordinary property, which an object literal
    // in generated code would not.
    await writeVersion(
      "0001",
      `{
        "defs": { "__proto__": { "type": "object" } },
        "operations": {
          "__proto__": { "input": {}, "outcomes": { "ok": {} } },
          "op": { "input": {}, "outcomes": { "__proto__": {} } }
        }
      }`,
    );

    expect(await problemsOf(readSchemas(gatewayDir, "0001"))).toEqual([
      'a shared definition cannot be named "__proto__"',
      'an operation cannot be named "__proto__"',
      'an outcome cannot be named "__proto__"',
    ]);
  });

  it("refuses that name inside a schema, wherever in one it appears", async () => {
    // A validator skips a property of this name rather than compiling it, finds a required one
    // on the prototype so it is never missing, and writes a schema value back out as an object
    // literal, where the key sets the prototype. A schema naming it says what it does not check.
    await writeVersion(
      "0001",
      `{
        "defs": { "Thing": { "const": { "__proto__": 1 } } },
        "operations": {
          "op": {
            "input": {
              "type": "object",
              "properties": { "__proto__": { "type": "string" } },
              "required": ["__proto__"]
            },
            "outcomes": {
              "ok": {
                "anyOf": [
                  { "type": "null" },
                  { "dependentRequired": { "a": ["__proto__"] } }
                ]
              }
            }
          }
        }
      }`,
    );

    expect(await problemsOf(readSchemas(gatewayDir, "0001"))).toEqual([
      'defs.Thing.const cannot declare "__proto__"',
      'operations.op.input.properties cannot declare "__proto__"',
      'operations.op.input.required cannot list "__proto__"',
      'operations.op.outcomes.ok.anyOf[1].dependentRequired.a cannot list "__proto__"',
    ]);
  });
});

describe("readSchemas, on text that does not display", () => {
  const describedAs = (description: string, name = "note") => ({
    operations: {
      op: {
        input: { type: "object", properties: { [name]: { description } } },
        outcomes: { ok: { type: "null", enum: [description] } },
      },
    },
  });

  it.each([
    ["a bidirectional override", "\u202E", "U+202E"],
    ["a bidirectional isolate", "\u2066", "U+2066"],
    ["a zero-width space", "\u200B", "U+200B"],
    ["a byte order mark", "\uFEFF", "U+FEFF"],
    ["a control character", "\u0007", "U+0007"],
    ["a line separator", "\u2028", "U+2028"],
  ])(
    "refuses %s wherever a version holds one",
    async (_what, hidden, named) => {
      await writeVersion("0001", describedAs(`safe${hidden}text`));

      expect(await problemsOf(readSchemas(gatewayDir, "0001"))).toEqual([
        `operations.op.input.properties.note.description holds a character that does not display (${named})`,
        `operations.op.outcomes.ok.enum.0 holds a character that does not display (${named})`,
      ]);
    },
  );

  it("finds one written as an escape, which the file's own text would not show", async () => {
    await writeVersion(
      "0001",
      JSON.stringify(describedAs("safe")).replace("safe", "sa\\u202Efe"),
    );

    const [problem] = await problemsOf(readSchemas(gatewayDir, "0001"));
    expect(problem).toContain("U+202E");
  });

  it("refuses one in a name as well as in a value", async () => {
    await writeVersion("0001", describedAs("safe", "no\u200Bte"));

    expect(await problemsOf(readSchemas(gatewayDir, "0001"))).toEqual([
      "operations.op.input.properties has a field whose name holds a character that does not display (U+200B)",
    ]);
  });

  it("accepts what a description is laid out with, and text in any script", async () => {
    const schemas = describedAs(
      "First line\n\tindented\r\nTrwydded yrru — 運転免許",
    );
    await writeVersion("0001", schemas);

    await expect(readSchemas(gatewayDir, "0001")).resolves.toEqual(schemas);
  });
});

describe("loadVersions", () => {
  it("reads every version, oldest first", async () => {
    await writeVersion("0001", schemasOf("ok"));
    await writeVersion("0002", schemasOf("created"));

    await expect(loadVersions(gatewayDir)).resolves.toEqual([
      { version: "0001", schemas: schemasOf("ok") },
      { version: "0002", schemas: schemasOf("created") },
    ]);
  });

  it("refuses a gateway whose versions cannot be listed", async () => {
    await writeVersion("0002", schemasOf("ok"));

    await expect(loadVersions(gatewayDir)).rejects.toThrow(SchemaStoreError);
  });
});
