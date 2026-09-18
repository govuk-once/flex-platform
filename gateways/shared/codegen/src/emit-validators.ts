import type { GatewaySchemas, JSONSchema } from "@repo/gateway-types";
import ajvModule from "ajv/dist/2020.js";
import standaloneModule from "ajv/dist/standalone/index.js";
import addFormatsModule from "ajv-formats";
import esbuild from "esbuild";

import { VALIDATORS_MODULE } from "./layout.ts";
import {
  assertIdentifier,
  formatSource,
  sortedEntries,
  writeGenerated,
} from "./output.ts";

const Ajv2020 = ajvModule.default;
const addFormats = addFormatsModule.default;
const standaloneCode = standaloneModule.default;

// Resolved during bundling, never left in the emitted output.
const FORMATS_IMPORT =
  'import { fullFormats as formats } from "ajv-formats/dist/formats.js";\n';

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

// What generation produced, held before anything is written: a caller with a further check to
// make runs it between the two steps, and a schema that is not a schema is refused by the
// first, as itself, rather than reported as whatever that check makes of it.
export interface CompiledValidators {
  readonly schemas: GatewaySchemas;
  readonly exportNames: readonly string[];
  readonly code: string;
}

export function compileValidators(schemas: GatewaySchemas): CompiledValidators {
  const ajv = new Ajv2020({
    code: {
      source: true,
      esm: true,
      lines: true,
      formats: ajvModule._`formats`,
    },
    strict: true,
    // Ajv's one strict-mode check that refuses a valid 2020-12 schema: it wants a tuple's length
    // pinned, so `prefixItems` beside an `items` that types the rest, or without a `minItems`
    // requiring the elements it names, would fail generation. Both describe an array the
    // validators and the call contract handle, so only this check is off.
    strictTuples: false,
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
    let validate;
    try {
      validate = ajv.getSchema($id);
    } catch (cause) {
      throw new Error(
        `Invalid schema for ${context}: ${(cause as Error).message}`,
        { cause },
      );
    }
    // An "$async" schema compiles to a validator that returns a promise. The dispatcher calls
    // validators synchronously and would read that promise as a value that passed, letting an
    // invalid request reach the upstream and an invalid response reach the caller, with the
    // rejection surfacing as an unhandled one. Nothing here can await it, so it is refused.
    // Ajv marks an asynchronous validator on the function; only that overload declares the
    // property, so its presence is what identifies one.
    if (validate !== undefined && "$async" in validate) {
      throw new Error(
        `Invalid schema for ${context}: "$async" is not supported, because validation is synchronous`,
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

  return { schemas, exportNames, code };
}

export async function writeValidators(
  compiled: CompiledValidators,
  outDir: string,
): Promise<void> {
  const { schemas, exportNames, code } = compiled;

  // Not prettier-formatted: bundled output, and esbuild rejecting bad input is the same check.
  const schemasJs = await bundleModule(FORMATS_IMPORT + "\n" + code);

  const operationEntries = sortedEntries(schemas.operations)
    .map(([opName, opSchemas]) => {
      const outcomes = sortedEntries(opSchemas.outcomes)
        .map(([name]) => `${name}: ${opName}_outcome_${name},`)
        .join("");

      return `${opName}: { input: ${opName}_input, outcomes: { ${outcomes} } },`;
    })
    .join("");

  const indexJs = await formatSource(
    [
      `import { ${exportNames.join(", ")} } from "./schemas.js";`,
      "",
      `export const validators = { ${operationEntries} };`,
    ].join("\n"),
    "babel",
  );

  await writeGenerated(outDir, "schemas.js", schemasJs);
  await writeGenerated(outDir, VALIDATORS_MODULE, indexJs);
}

// Both steps, for a caller with nothing to do between them.
export async function emitValidators(
  schemas: GatewaySchemas,
  outDir: string,
): Promise<void> {
  await writeValidators(compileValidators(schemas), outDir);
}
