import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { GatewaySchemas } from "@repo/gateway-types";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emitContract } from "./emit-contract.ts";
import { emitValidators } from "./emit-validators.ts";
import { CONTRACT_MODULE } from "./layout.ts";

// Generated beside the package rather than in the system temp directory: the contract imports
// @repo/gateway-types, which resolves from here, and the compiler check needs it to resolve.
const GENERATED_ROOT = path.join(import.meta.dirname, "..", ".gen");

const GATEWAY_ID = "test";

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
        properties: {
          payload: {
            type: "object",
            properties: { email: { type: "string" } },
            required: ["email"],
          },
        },
        required: ["payload"],
      },
      outcomes: { created: { $ref: "UserRecord" } },
    },
    getIdentityExchange: {
      input: {
        type: "object",
        properties: {
          subjectId: { type: "string" },
          // A dictionary beside a declared property, and a shape split across a combinator:
          // both must reach the consumer as a type that compiles.
          labels: {
            type: "object",
            properties: { count: { type: "integer" } },
            additionalProperties: { type: "string" },
          },
          filter: {
            type: "object",
            properties: { since: { type: "string" } },
            required: ["since"],
            allOf: [
              {
                type: "object",
                properties: { until: { type: "string" } },
                required: ["until"],
              },
            ],
          },
          // Required in one part of the composition and declared in another.
          actor: {
            type: "object",
            required: ["id"],
            allOf: [{ type: "object", properties: { id: { type: "string" } } }],
          },
          // A reference that requires one of the fields it declares as optional.
          subject: {
            $ref: "UserRecord",
            type: "object",
            required: ["createdAt"],
          },
          // A reference beside an object fragment that declares nothing of its own.
          owner: { $ref: "UserRecord", type: "object" },
          // Patterns with nothing said about the names they do not match, which the validator
          // admits: what an arbitrary name carries has to reach the consumer as unknown.
          tags: {
            type: "object",
            patternProperties: { "^x-": { type: "string" } },
          },
          // Object keywords beside a type that also admits null.
          scope: {
            type: ["object", "null"],
            allOf: [
              {
                properties: { tenant: { type: "string" } },
                required: ["tenant"],
              },
            ],
          },
          // An array whose first element is typed by position.
          page: {
            type: "array",
            prefixItems: [{ type: "number" }],
            items: { type: "string" },
            minItems: 1,
          },
          // Named elements no length requires, of the shapes that need brackets.
          marks: {
            type: "array",
            prefixItems: [
              { type: ["string", "null"] },
              { type: "array", items: { type: "number" } },
              {
                type: "object",
                properties: { at: { type: "string" } },
                required: ["at"],
              },
            ],
          },
          // The same, through a union: each branch is read against what encloses it.
          window: {
            type: ["object", "null"],
            required: ["from"],
            anyOf: [
              { properties: { from: { type: "string" } } },
              { properties: { from: { type: "number" } } },
            ],
          },
        },
        required: ["subjectId"],
      },
      outcomes: {
        ok: {
          type: "object",
          properties: { linkedId: { type: "string" } },
          required: ["linkedId"],
        },
        unlinked: { type: "null" },
      },
    },
  },
};

// The repository's own compiler settings, read from this package's tsconfig rather than repeated,
// so the contract is checked as a consumer checks it. Without ambient types: a contract needs none.
const COMPILER_OPTIONS: ts.CompilerOptions = {
  ...ts.getParsedCommandLineOfConfigFile(
    path.join(import.meta.dirname, "..", "tsconfig.json"),
    undefined,
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    },
  )?.options,
  types: [],
};

function compile(...files: string[]): string[] {
  const program = ts.createProgram(files, COMPILER_OPTIONS);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) =>
    ts.formatDiagnostic(diagnostic, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => GENERATED_ROOT,
      getNewLine: () => "\n",
    }),
  );
}

let outDir: string;
let contract: string;
let source: string;

beforeAll(async () => {
  await mkdir(GENERATED_ROOT, { recursive: true });
  outDir = await mkdtemp(path.join(GENERATED_ROOT, "contract-"));
  await emitContract(GATEWAY_ID, schemas, outDir);
  contract = path.join(outDir, CONTRACT_MODULE);
  source = await readFile(contract, "utf-8");
}, 30_000);

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe("emitted contract", () => {
  it("carries the do-not-edit header and names the gateway", () => {
    expect(source.startsWith("// GENERATED FILE.")).toBe(true);
    expect(source).toContain('call contract for gateway "test"');
  });

  it("declares a shared definition once and refers to it by name", () => {
    expect(source).toContain(
      "export type UserRecord = { readonly id: string; readonly createdAt?: string };",
    );
    expect(source).toContain("readonly data: UserRecord");
  });

  it("carries the request body under payload and mapped fields at the top level", () => {
    expect(source).toContain(
      "export type CreateUserInput = { readonly payload: { readonly email: string } };",
    );
    expect(source).toContain("export type GetIdentityExchangeInput = {");
    expect(source).toContain("readonly subjectId: string;");
    // The index signature admits the declared property's type as well, or it would not compile.
    expect(source).toContain(
      "readonly [key: string]: string | number | undefined;",
    );
    // A combinator constrains the shape beside it rather than replacing it, and the object
    // keywords of both become one declaration.
    expect(source).toContain(
      "readonly filter?: { readonly since: string; readonly until: string };",
    );
    // A reference keeps its name, with what the composition adds beside it.
    expect(source).toContain(
      "readonly subject?: UserRecord & { readonly createdAt: string };",
    );
    expect(source).toContain(
      "readonly scope?: { readonly tenant: string } | null;",
    );
  });

  it("discriminates the declared outcomes", () => {
    expect(source).toContain(
      '{ readonly outcome: "ok"; readonly data: { readonly linkedId: string } }',
    );
    expect(source).toContain(
      '{ readonly outcome: "unlinked"; readonly data: null }',
    );
  });

  it("documents definitions, operations, outcomes and fields, and still compiles", async () => {
    const documented: GatewaySchemas = {
      defs: {
        Licence: {
          type: "object",
          description: "A driving licence\nas the upstream holds it",
          properties: {
            number: { type: "string", description: "The licence number" },
            status: { type: "string", deprecated: true },
          },
          required: ["number"],
        },
      },
      operations: {
        getLicence: {
          input: {
            type: "object",
            properties: { number: { type: "string", title: "Licence number" } },
            required: ["number"],
            additionalProperties: false,
          },
          outcomes: {
            ok: { $ref: "Licence", description: "The licence that was found" },
          },
        },
      },
    };
    const dir = await mkdtemp(path.join(GENERATED_ROOT, "documented-"));
    try {
      await emitContract(GATEWAY_ID, documented, dir, {
        descriptions: { getLicence: "Look a licence up by its number" },
      });
      const emitted = await readFile(path.join(dir, CONTRACT_MODULE), "utf-8");

      expect(emitted).toContain(
        [
          "/**",
          " * A driving licence",
          " * as the upstream holds it",
          " */",
          "export type Licence = {",
          "  /** The licence number */",
          "  readonly number: string;",
          "  /** @deprecated */",
          "  readonly status?: string;",
          "};",
        ].join("\n"),
      );
      expect(emitted).toContain(
        [
          "/** Look a licence up by its number */",
          "export type GetLicenceInput = {",
          "  /** Licence number */",
          "  readonly number: string;",
          "};",
        ].join("\n"),
      );
      expect(emitted).toContain(
        [
          "  /** The licence that was found */",
          "  readonly data: Licence;",
        ].join("\n"),
      );
      expect(emitted).toContain(
        [
          "  /** Look a licence up by its number */",
          "  readonly getLicence: {",
        ].join("\n"),
      );
      expect(compile(path.join(dir, CONTRACT_MODULE))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps hostile text inside its comments, wherever a comment is written", async () => {
    // The same text in every place a comment comes from. Were any of it to leave its comment,
    // the contract would declare `injected`, or stop compiling.
    const hostile = "fine */ export type injected = true; /* \n@deprecated\n*/";
    const schemas: GatewaySchemas = {
      defs: { Thing: { type: "object", description: hostile } },
      operations: {
        op: {
          input: {
            type: "object",
            properties: { field: { type: "string", description: hostile } },
          },
          outcomes: { ok: { $ref: "Thing", description: hostile } },
        },
      },
    };
    const dir = await mkdtemp(path.join(GENERATED_ROOT, "hostile-"));
    try {
      await emitContract(GATEWAY_ID, schemas, dir, {
        descriptions: { op: hostile },
      });
      const file = path.join(dir, CONTRACT_MODULE);
      const parsed = ts.createSourceFile(
        file,
        await readFile(file, "utf-8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const declared = parsed.statements
        .filter(ts.isTypeAliasDeclaration)
        .map((statement) => statement.name.text);
      const deprecated = parsed.statements.filter(
        (statement) => ts.getJSDocDeprecatedTag(statement) !== undefined,
      );

      expect(declared).not.toContain("injected");
      expect(deprecated).toEqual([]);
      expect(compile(file)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("describes schemas the validators are generated from", async () => {
    // The contract and the validators read the same schemas: a shape one of them accepts and
    // the other refuses would reach a gateway as a type that does not match its validation.
    await expect(
      emitValidators(schemas, path.join(outDir, "validators")),
    ).resolves.toBeUndefined();
  }, 30_000);

  it("compiles, and checks a consumer against the declared outcomes", async () => {
    const consumer = path.join(outDir, "consumer.ts");
    await writeFile(
      consumer,
      `
import type {
  CreateUserInput,
  GatewayRequest,
  GetIdentityExchangeResponse,
  OperationInput,
  OperationName,
} from "./${CONTRACT_MODULE}";

// Every declared outcome is handled, so the union is exhausted and nothing is left over.
export function describeResponse(response: GetIdentityExchangeResponse): string {
  if (!response.ok) return response.error.code;
  switch (response.outcome) {
    case "ok":
      return response.data.linkedId;
    case "unlinked":
      return "none";
    default: {
      const exhausted: never = response;
      return exhausted;
    }
  }
}

export const request: GatewayRequest = {
  operation: "createUser",
  input: { payload: { email: "a@b.test" } },
  secure: { values: {}, signature: "" },
};

export const named: OperationName = "getIdentityExchange";

// A dictionary beside a declared property, and a shape declared across a combinator.
export const dictionary: OperationInput<"getIdentityExchange">["labels"] = {
  count: 2,
  other: "kept",
};
export const composed: OperationInput<"getIdentityExchange">["filter"] = {
  since: "2026-01-01",
  until: "2026-02-01",
};

type Input = OperationInput<"getIdentityExchange">;

// Required wherever the composition declares it.
export const actor: Input["actor"] = { id: "a-1" };
// @ts-expect-error the composition requires id
export const actorWithout: Input["actor"] = {};

// A reference keeps its own fields, and the one the composition requires is no longer optional.
export const subject: Input["subject"] = { id: "u-1", createdAt: "2026-01-01" };
// @ts-expect-error the composition requires createdAt
export const subjectWithout: Input["subject"] = { id: "u-1" };

// An object fragment declaring nothing leaves the reference as the whole of the shape.
export const owner: Input["owner"] = { id: "u-1" };
export const ownerId: string | undefined = owner?.id;
// @ts-expect-error the definition declares no field of that name
export const ownerOther: unknown = owner?.undeclared;

// A pattern types the names it matches and says nothing about the rest, which the gateway still
// takes: reading one as the pattern's type would compile here and fail there.
export const tags: Input["tags"] = { "x-team": "core", unmatched: 123 };
// @ts-expect-error what an arbitrary name carries is unknown, not the pattern's type
export const tagLength: number = tags?.["x-team"].length;

// The object keywords narrow the object; null is still admitted.
export const scope: Input["scope"] = null;
export const scopeObject: Input["scope"] = { tenant: "acme" };

// The element a tuple prefix names keeps its own type.
export const page: Input["page"] = [1, "a", "b"];
// @ts-expect-error the first element is a number
export const pageWrong: Input["page"] = ["a"];

// Optional named elements, each of a shape that has to be bracketed to parse.
export const marks: Input["marks"] = [null, [1, 2], { at: "now" }, "anything"];
export const noMarks: Input["marks"] = [];
// @ts-expect-error the second element is an array of numbers
export const marksWrong: Input["marks"] = ["a", "b"];

// A union branch carries the enclosing type and requiredness.
export const windowNull: Input["window"] = null;
export const windowText: Input["window"] = { from: "2026-01-01" };
export const windowNumber: Input["window"] = { from: 1 };
// @ts-expect-error the composition requires from
export const windowWithout: Input["window"] = {};
export const input: OperationInput<"createUser"> = { payload: { email: "a@b.test" } };

// @ts-expect-error the gateway declares no outcome of that name
export const unknownOutcome: GetIdentityExchangeResponse = { ok: true, outcome: "archived", data: null };

// @ts-expect-error the request body travels under "payload", not as a top-level field
export const wrongShape: CreateUserInput = { email: "a@b.test" };

// @ts-expect-error the gateway defines no operation of that name
export const unknownOperation: OperationName = "deleteUser";
`,
    );

    expect(compile(contract, consumer)).toEqual([]);
  }, 60_000);
});

describe("generation errors", () => {
  it("refuses a definition and an operation that need the same type name", async () => {
    const clash: GatewaySchemas = {
      defs: { CreateUserInput: { type: "object" } },
      operations: schemas.operations,
    };

    await expect(emitContract(GATEWAY_ID, clash, outDir)).rejects.toThrow(
      /both need the type name "CreateUserInput"/,
    );
  });

  it("refuses a definition that needs a name the contract declares", async () => {
    const clash: GatewaySchemas = {
      defs: { OperationName: { type: "string" } },
      operations: schemas.operations,
    };

    await expect(emitContract(GATEWAY_ID, clash, outDir)).rejects.toThrow(
      /both need the type name "OperationName"/,
    );
  });

  it("refuses a definition that needs a name TypeScript uses", async () => {
    const clash: GatewaySchemas = {
      defs: { Record: { type: "object" } },
      operations: schemas.operations,
    };

    await expect(emitContract(GATEWAY_ID, clash, outDir)).rejects.toThrow(
      /both need the type name "Record"/,
    );
  });

  it("refuses an operation whose types would collide with the generic helpers", async () => {
    const clash: GatewaySchemas = {
      operations: {
        operation: { input: { type: "object" }, outcomes: { ok: {} } },
      },
    };

    await expect(emitContract(GATEWAY_ID, clash, outDir)).rejects.toThrow(
      /both need the type name "OperationInput"/,
    );
  });

  it("refuses a name that is not an identifier", async () => {
    const bad: GatewaySchemas = {
      operations: { "get-user": { input: {}, outcomes: { ok: {} } } },
    };

    await expect(emitContract(GATEWAY_ID, bad, outDir)).rejects.toThrow(
      /get-user/,
    );
  });
});
