import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import ajvModule from "ajv/dist/2020.js";
import standaloneModule from "ajv/dist/standalone/index.js";
import addFormatsModule from "ajv-formats";
import esbuild from "esbuild";
import { format } from "prettier";

import type { GatewaySchemas, JSONSchema } from "./types.ts";

const Ajv2020 = ajvModule.default;
const addFormats = addFormatsModule.default;
const standaloneCode = standaloneModule.default;

const HEADER =
  "// GENERATED FILE. Do not edit. Produced by @repo/gateway-codegen.\n";

// Resolved during bundling, never left in the emitted output.
const FORMATS_IMPORT =
  'import { fullFormats as formats } from "ajv-formats/dist/formats.js";\n';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Deterministic iteration. Output must not depend on key insertion order.
function sortedEntries<T>(record: Record<string, T>): [string, T][] {
  return Object.keys(record)
    .sort()
    .map((key) => [key, record[key]!]);
}

function assertIdentifier(name: string, what: string): void {
  if (!IDENTIFIER.test(name)) {
    throw new Error(
      `${what} "${name}" is not a valid JavaScript identifier, so it cannot be used as an export name.`,
    );
  }
}

// Bundle Ajv's formats and keyword helpers so emitted validators have no package imports or
// unresolved CommonJS requires. Resolve from codegen's dependencies, independent of the caller.
async function bundleModule(source: string): Promise<string> {
  const built = await esbuild.build({
    stdin: { contents: source, resolveDir: import.meta.dirname, loader: "js" },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    write: false,
  });

  const output = built.outputFiles[0];
  if (!output) {
    throw new Error("esbuild produced no output when bundling validators");
  }
  return output.text;
}

async function formatSource(source: string): Promise<string> {
  try {
    return await format(source, { parser: "babel", printWidth: 100 });
  } catch (cause) {
    throw new Error("Generated output is not parseable", { cause });
  }
}

export async function emitValidators(
  schemas: GatewaySchemas,
  outDir: string,
): Promise<void> {
  const ajv = new Ajv2020({
    code: {
      source: true,
      esm: true,
      lines: true,
      formats: ajvModule._`formats`,
    },
    strict: true,
    allErrors: false,
  });

  addFormats(ajv, { mode: "full" });

  const registered: { $id: string; context: string }[] = [];

  const register = (schema: JSONSchema, $id: string, context: string): void => {
    try {
      // $id is assigned from the map key, overwriting any $id in the source
      // schema. References between defs must therefore use the def's key.
      ajv.addSchema({ ...schema, $id });
    } catch (cause) {
      throw new Error(
        `Invalid schema for ${context}: ${(cause as Error).message}`,
        { cause },
      );
    }
    registered.push({ $id, context });
  };

  for (const [name, schema] of sortedEntries(schemas.defs ?? {})) {
    assertIdentifier(name, "Shared definition");
    register(schema, name, `shared definition "${name}"`);
  }

  const exportNames: string[] = [];

  for (const [opName, opSchemas] of sortedEntries(schemas.operations)) {
    assertIdentifier(opName, "Operation");

    const inputId = `${opName}_input`;
    register(opSchemas.input, inputId, `input of operation "${opName}"`);
    exportNames.push(inputId);

    for (const [outcomeName, outcomeSchema] of sortedEntries(
      opSchemas.outcomes,
    )) {
      assertIdentifier(outcomeName, "Outcome");
      const outcomeId = `${opName}_outcome_${outcomeName}`;
      register(
        outcomeSchema,
        outcomeId,
        `outcome "${outcomeName}" of operation "${opName}"`,
      );
      exportNames.push(outcomeId);
    }
  }

  for (const { $id, context } of registered) {
    try {
      ajv.getSchema($id);
    } catch (cause) {
      throw new Error(
        `Invalid schema for ${context}: ${(cause as Error).message}`,
        { cause },
      );
    }
  }

  const exportMap = Object.fromEntries(exportNames.map((id) => [id, id]));

  let code: string;
  try {
    code = standaloneCode(ajv, exportMap);
  } catch (cause) {
    throw new Error("Failed to generate standalone validator code", { cause });
  }

  // Not prettier-formatted: bundled output, and esbuild rejecting bad input is the same check.
  const schemasJs = HEADER + (await bundleModule(FORMATS_IMPORT + "\n" + code));

  const operationEntries = sortedEntries(schemas.operations)
    .map(([opName, opSchemas]) => {
      const outcomes = sortedEntries(opSchemas.outcomes)
        .map(([name]) => `${name}: ${opName}_outcome_${name},`)
        .join("");

      return `${opName}: { input: ${opName}_input, outcomes: { ${outcomes} } },`;
    })
    .join("");

  const indexJs =
    HEADER +
    (await formatSource(
      [
        `import { ${exportNames.join(", ")} } from "./schemas.js";`,
        "",
        `export const validators = { ${operationEntries} };`,
      ].join("\n"),
    ));

  await mkdir(outDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outDir, "schemas.js"), schemasJs),
    writeFile(path.join(outDir, "index.js"), indexJs),
  ]);
}
