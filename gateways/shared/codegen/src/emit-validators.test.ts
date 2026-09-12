import { execFile as execFileCb } from "node:child_process";
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emitValidators } from "./emit-validators.ts";
import type { GatewaySchemas, Validator } from "./types.ts";

const schemas: GatewaySchemas = {
  defs: {
    UserRecord: {
      type: "object",
      properties: {
        id: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
      },
      required: ["id"],
    },
  },
  operations: {
    createUser: {
      input: {
        type: "object",
        properties: { email: { type: "string" } },
        required: ["email"],
        additionalProperties: false,
      },
      outcomes: {
        created: { $ref: "UserRecord" },
      },
    },
    getIdentityExchange: {
      input: {
        type: "object",
        properties: { subjectId: { type: "string" } },
        required: ["subjectId"],
        additionalProperties: false,
      },
      outcomes: {
        record: {
          type: "object",
          properties: { linkedId: { type: "string" } },
          required: ["linkedId"],
        },
      },
    },

    // Covers keyword and format validation, including the ucs2length runtime helper.
    searchRecords: {
      input: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 2, maxLength: 64 },
          tags: { type: "array", items: { type: "string" }, uniqueItems: true },
          status: { enum: ["active", "archived"] },
          since: { type: "string", format: "date-time" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      outcomes: {
        page: {
          type: "object",
          properties: {
            total: { type: "integer", minimum: 0 },
            ids: {
              type: "array",
              items: { type: "string", pattern: "^[a-z0-9-]+$" },
            },
          },
          required: ["total"],
        },
      },
    },
  },
};

interface IndexModule {
  validators: {
    createUser: { input: Validator; outcomes: { created: Validator } };
    getIdentityExchange: { input: Validator; outcomes: { record: Validator } };
    searchRecords: { input: Validator; outcomes: { page: Validator } };
  };
}

const execFile = promisify(execFileCb);

const OUTPUT_FILES = ["schemas.js", "index.js"];

let tmp: string;
let index: IndexModule;

beforeAll(async () => {
  tmp = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "emit-validators-")),
  );
  await emitValidators(schemas, tmp);
  index = (await import(
    pathToFileURL(path.join(tmp, "index.js")).href
  )) as IndexModule;
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("emitted files", () => {
  it("writes the index and schemas", async () => {
    for (const file of OUTPUT_FILES) {
      await expect(access(path.join(tmp, file))).resolves.not.toThrow();
    }
  });

  it("emits only JavaScript, no declarations", async () => {
    // Validator output is plain JavaScript; a declaration would reintroduce a package import.
    const files = await readdir(tmp);
    expect(files.toSorted()).toEqual(OUTPUT_FILES.toSorted());
  });

  it("inlines every dependency rather than importing it", async () => {
    // Grepping for `require(` is not the check: esbuild's own __require shim and an Ajv string
    // literal both match it. Assert on imports; the subprocess test proves the module loads.
    const source = await readFile(path.join(tmp, "schemas.js"), "utf-8");
    expect(source).not.toMatch(/from\s+"ajv/);
    expect(source).not.toMatch(/from\s+"\.\/formats\.js"/);
  });

  it("emits no package imports at all", async () => {
    // Generated validators must resolve independently of codegen's installed dependencies.
    for (const file of OUTPUT_FILES) {
      const source = await readFile(path.join(tmp, file), "utf-8");
      const bare = [
        ...source.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+"([^"]+)"/gm),
      ]
        .map((m) => m[1])
        .filter((spec) => spec !== undefined && !spec.startsWith("."));

      expect(bare, `${file} imports packages: ${bare.join(", ")}`).toEqual([]);
    }
  });

  it("runs under plain node, outside any node_modules", async () => {
    // A plain Node subprocess checks module loading without Vitest's dependency resolution.
    const script = `
      const { validators } = await import(${JSON.stringify(pathToFileURL(path.join(tmp, "index.js")).href)});
      if (validators.createUser.input({ email: "a@b.com" }) !== true) throw new Error("valid input rejected");
      if (validators.createUser.input({}) !== false) throw new Error("invalid input accepted");
      if (validators.createUser.outcomes.created({ id: "1", createdAt: "nope" }) !== false) throw new Error("format not enforced");
      if (validators.searchRecords.input({ query: "abc" }) !== true) throw new Error("valid search rejected");
      if (validators.searchRecords.input({ query: "a" }) !== false) throw new Error("minLength not enforced (ucs2length helper missing)");
      if (validators.searchRecords.input({ query: "abc", tags: ["a", "a"] }) !== false) throw new Error("uniqueItems not enforced");
      console.log("ok");
    `;

    const { stdout } = await execFile(process.execPath, [
      "--input-type=module",
      "-e",
      script,
    ]);
    expect(stdout.trim()).toBe("ok");
  });

  it("carries a do-not-edit header on every file", async () => {
    for (const file of OUTPUT_FILES) {
      const source = await readFile(path.join(tmp, file), "utf-8");
      expect(source.startsWith("// GENERATED FILE.")).toBe(true);
    }
  });
});

describe("input validation", () => {
  it("accepts valid input", () => {
    expect(index.validators.createUser.input({ email: "a@b.com" })).toBe(true);
  });

  it("rejects a missing required field", () => {
    expect(index.validators.createUser.input({})).toBe(false);
    expect(index.validators.createUser.input.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyword: "required" }),
      ]),
    );
  });

  it("rejects additional properties", () => {
    expect(
      index.validators.createUser.input({ email: "a@b.com", extra: true }),
    ).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(index.validators.createUser.input("nope")).toBe(false);
    expect(index.validators.createUser.input(null)).toBe(false);
  });

  it("validates the second operation independently", () => {
    expect(
      index.validators.getIdentityExchange.input({ subjectId: "abc" }),
    ).toBe(true);
    expect(index.validators.getIdentityExchange.input({})).toBe(false);
  });
});

describe("outcome validation", () => {
  it("resolves $ref to a shared definition", () => {
    expect(index.validators.createUser.outcomes.created({ id: "123" })).toBe(
      true,
    );
    expect(
      index.validators.createUser.outcomes.created({
        id: "123",
        createdAt: "2024-01-01T00:00:00Z",
      }),
    ).toBe(true);
  });

  it("rejects a missing required field through the $ref", () => {
    expect(index.validators.createUser.outcomes.created({})).toBe(false);
  });

  it("enforces format at runtime", () => {
    // Fails if code.formats is misbound: the validator would silently pass
    // anything, because the format lookup resolves to undefined.
    expect(
      index.validators.createUser.outcomes.created({
        id: "123",
        createdAt: "not-a-date",
      }),
    ).toBe(false);
  });

  it("validates the second operation's outcome", () => {
    expect(
      index.validators.getIdentityExchange.outcomes.record({
        linkedId: "xyz",
      }),
    ).toBe(true);
    expect(index.validators.getIdentityExchange.outcomes.record({})).toBe(
      false,
    );
  });
});

describe("keyword and format validation", () => {
  // Check validation results as well as module loading; minLength exercises a runtime helper.
  const input = (over: Record<string, unknown> = {}) =>
    index.validators.searchRecords.input({ query: "abc", ...over });

  it("enforces minLength and maxLength (ucs2length)", () => {
    expect(input({ query: "ab" })).toBe(true);
    expect(input({ query: "a" })).toBe(false);
    expect(input({ query: "x".repeat(64) })).toBe(true);
    expect(input({ query: "x".repeat(65) })).toBe(false);
  });

  it("counts surrogate pairs the way ucs2length does", () => {
    // "👍" is two UTF-16 code units but one character: a naive .length passes minLength: 2.
    expect(input({ query: "👍" })).toBe(false);
    expect(input({ query: "👍👍" })).toBe(true);
  });

  it("enforces uniqueItems for strings", () => {
    expect(input({ tags: ["a", "b"] })).toBe(true);
    expect(input({ tags: ["a", "a"] })).toBe(false);
  });

  it("enforces enum", () => {
    expect(input({ status: "active" })).toBe(true);
    expect(input({ status: "deleted" })).toBe(false);
  });

  it("enforces date-time format", () => {
    expect(input({ since: "2024-01-01T00:00:00Z" })).toBe(true);
    expect(input({ since: "2024-13-01T00:00:00Z" })).toBe(false);
  });

  it("enforces pattern and minimum on an outcome", () => {
    const page = index.validators.searchRecords.outcomes.page;
    expect(page({ total: 0, ids: ["ab-1"] })).toBe(true);
    expect(page({ total: -1 })).toBe(false);
    expect(page({ total: 1, ids: ["NOT LOWER"] })).toBe(false);
  });
});

describe("barrel", () => {
  it("exposes every operation keyed by name", () => {
    expect(Object.keys(index.validators)).toEqual([
      "createUser",
      "getIdentityExchange",
      "searchRecords",
    ]);
  });

  it("wires each validator to the right schema", () => {
    expect(index.validators.createUser.input({ email: "a@b.com" })).toBe(true);
    expect(index.validators.createUser.outcomes.created({ id: "1" })).toBe(
      true,
    );
    expect(
      index.validators.getIdentityExchange.outcomes.record({
        linkedId: "x",
      }),
    ).toBe(true);
  });

  it("references the same function objects as the schemas module", async () => {
    const schemas = (await import(
      pathToFileURL(path.join(tmp, "schemas.js")).href
    )) as Record<string, Validator>;
    expect(index.validators.createUser.input).toBe(schemas.createUser_input);
  });
});

describe("generation errors", () => {
  it("names the operation for an unknown keyword", async () => {
    const bad: GatewaySchemas = {
      operations: {
        broken: {
          input: {
            type: "object",
            properties: {},
            unknownKeyword: true,
          },
          outcomes: { ok: { type: "object" } },
        },
      },
    };

    // Strict-mode errors surface during compilation, not registration, so this
    // only names the operation if compilation is forced with context in hand.
    await expect(
      emitValidators(bad, path.join(tmp, "bad-keyword")),
    ).rejects.toThrow(/input of operation "broken"/);
  });

  it("names the outcome for an unknown format", async () => {
    const bad: GatewaySchemas = {
      operations: {
        broken: {
          input: { type: "object" },
          outcomes: {
            ok: { type: "object", properties: { x: { format: "nonsense" } } },
          },
        },
      },
    };

    await expect(
      emitValidators(bad, path.join(tmp, "bad-format")),
    ).rejects.toThrow(/outcome "ok" of operation "broken"/);
  });

  it("rejects an operation name that is not a valid identifier", async () => {
    const bad: GatewaySchemas = {
      operations: {
        "get-user": { input: { type: "object" }, outcomes: { ok: {} } },
      },
    };

    await expect(
      emitValidators(bad, path.join(tmp, "bad-name")),
    ).rejects.toThrow(/get-user/);
  });

  it("rejects an unresolvable $ref", async () => {
    const bad: GatewaySchemas = {
      operations: {
        broken: {
          input: { type: "object" },
          outcomes: { ok: { $ref: "DoesNotExist" } },
        },
      },
    };

    await expect(
      emitValidators(bad, path.join(tmp, "bad-ref")),
    ).rejects.toThrow();
  });
});
