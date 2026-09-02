import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import ajvModule from "ajv/dist/2020.js";
import standaloneModule from "ajv/dist/standalone/index.js";
import addFormatsModule from "ajv-formats";
import { format } from "prettier";

import type { GatewaySchemas, JSONSchema } from "./types.ts";

const Ajv2020 = ajvModule.default;
const addFormats = addFormatsModule.default;
const standaloneCode = standaloneModule.default;

const HEADER =
  "// GENERATED FILE. Do not edit. Produced by @repo/gateway-codegen.\n";

const FORMATS_IMPORT =
  'import { fullFormats as formats } from "ajv-formats/dist/formats.js";\n';

const VALIDATOR_IMPORT =
  'import type { Validator } from "@repo/gateway-codegen";\n';

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

async function formatSource(
  source: string,
  parser: "babel" | "typescript",
): Promise<string> {
  try {
    return await format(source, { parser, printWidth: 100 });
  } catch (cause) {
    throw new Error(`Generated ${parser} output is not parseable`, { cause });
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

  const schemasJs =
    HEADER + (await formatSource(FORMATS_IMPORT + "\n" + code, "babel"));

  const schemasDts =
    HEADER +
    (await formatSource(
      VALIDATOR_IMPORT +
        "\n" +
        exportNames
          .map((id) => `export declare const ${id}: Validator;\n`)
          .join(""),
      "typescript",
    ));

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
      "babel",
    ));

  const indexTypes = sortedEntries(schemas.operations)
    .map(([opName, opSchemas]) => {
      const outcomes = sortedEntries(opSchemas.outcomes)
        .map(([name]) => `${name}: Validator;`)
        .join(" ");

      return `${opName}: { input: Validator; outcomes: { ${outcomes} } };`;
    })
    .join("");

  const indexDts =
    HEADER +
    (await formatSource(
      [
        VALIDATOR_IMPORT,
        `export declare const validators: { ${indexTypes} };`,
      ].join("\n"),
      "typescript",
    ));

  await mkdir(outDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outDir, "schemas.js"), schemasJs),
    writeFile(path.join(outDir, "schemas.d.ts"), schemasDts),
    writeFile(path.join(outDir, "index.js"), indexJs),
    writeFile(path.join(outDir, "index.d.ts"), indexDts),
  ]);
}
