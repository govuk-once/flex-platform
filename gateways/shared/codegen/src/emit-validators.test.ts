import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  },
};

interface IndexModule {
  validators: {
    createUser: { input: Validator; outcomes: { created: Validator } };
    getIdentityExchange: { input: Validator; outcomes: { record: Validator } };
  };
}

const OUTPUT_FILES = ["schemas.js", "schemas.d.ts", "index.js", "index.d.ts"];

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
  it("writes the index, schemas and their type files", async () => {
    for (const file of OUTPUT_FILES) {
      await expect(access(path.join(tmp, file))).resolves.not.toThrow();
    }
  });

  it("emits no require() into ESM output", async () => {
    // ajv-formats' documented snippet emits require(), which throws at import
    // time in an ESM module. Generation still succeeds, so only this catches it.
    const source = await readFile(path.join(tmp, "schemas.js"), "utf-8");
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).toMatch(
      /^import .* from "ajv-formats\/dist\/formats\.js";/m,
    );
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

describe("barrel", () => {
  it("exposes every operation keyed by name", () => {
    expect(Object.keys(index.validators)).toEqual([
      "createUser",
      "getIdentityExchange",
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
