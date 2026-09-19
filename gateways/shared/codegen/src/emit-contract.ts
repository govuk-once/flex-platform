import type { GatewaySchemas, JSONSchema } from "@repo/gateway-types";
import { sortedEntries } from "@repo/utils/sorted-entries";

import { CONTRACT_MODULE } from "./layout.ts";
import { assertIdentifier, formatSource, writeGenerated } from "./output.ts";
import { type TypeContext, typeExpression } from "./schema-types.ts";

// What a schema was read for, added to whatever reading it threw: the translator is given one
// schema and knows nothing of the operation it belongs to, and the command prints a message and
// nothing else.
function typeOf(schema: JSONSchema, ctx: TypeContext, context: string): string {
  try {
    return typeExpression(schema, ctx);
  } catch (cause) {
    throw new Error(
      `Cannot describe ${context}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

// The call contract, as types only. A caller names an operation, builds its input and reads the
// response; nothing here is imported at runtime, so a consumer takes the contract without the
// gateway's dependencies.

const preamble = (id: string) => `// The call contract for gateway "${id}".
//
// Each operation takes one flat input object: the fields the operation maps to the upstream
// request at the top level, and the request body, when the operation has one, under "payload".
// A response is an error envelope or a success carrying one of the operation's declared
// outcomes, so a switch over \`outcome\` is checked for exhaustiveness.`;

// Names TypeScript needs for itself: the utilities the generated declarations use, and the
// intrinsic types, which cannot be declared as an alias at all. A definition that took one of
// them would shadow it and the contract would not compile.
const TYPESCRIPT_NAMES = [
  "Record",
  "Readonly",
  "any",
  "bigint",
  "boolean",
  "never",
  "null",
  "number",
  "object",
  "string",
  "symbol",
  "undefined",
  "unknown",
  "void",
];

// What the contract imports and declares for itself. A shared definition or an operation that
// needs one of these names would emit a second declaration of it, so generation fails instead.
const GENERATED_NAMES = [
  "EnvelopeError",
  "SecureValue",
  "Operations",
  "OperationName",
  "OperationInput",
  "OperationResult",
  "OperationResponse",
  "GatewayRequest",
];

function pascalCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Every exported name, so a shared definition and an operation cannot claim the same one and
// leave the later declaration to win silently.
function claim(names: Map<string, string>, name: string, owner: string): void {
  const existing = names.get(name);
  if (existing !== undefined) {
    throw new Error(
      `${owner} and ${existing} both need the type name "${name}"; rename one of them.`,
    );
  }
  names.set(name, owner);
}

function outcomeUnion(
  operation: string,
  outcomes: Record<string, JSONSchema>,
  ctx: TypeContext,
): string {
  const members = sortedEntries(outcomes).map(
    ([name, schema]) =>
      `{ readonly outcome: ${JSON.stringify(name)}; readonly data: ${typeOf(schema, ctx, `outcome "${name}" of operation "${operation}"`)} }`,
  );
  // An operation with no outcomes is refused before this runs; `never` would silently stand in.
  return members.join(" | ");
}

export async function emitContract(
  gatewayId: string,
  schemas: GatewaySchemas,
  clientDir: string,
): Promise<void> {
  const claimed = new Map<string, string>([
    ...TYPESCRIPT_NAMES.map((name): [string, string] => [
      name,
      "TypeScript itself",
    ]),
    ...GENERATED_NAMES.map((name): [string, string] => [
      name,
      "the contract's own declarations",
    ]),
  ]);
  const defs = new Map<string, string>();
  const defEntries = sortedEntries(schemas.defs ?? {});

  for (const [name] of defEntries) {
    assertIdentifier(name, "Shared definition");
    claim(claimed, name, `shared definition "${name}"`);
    defs.set(name, name);
  }

  const ctx: TypeContext = { defs, schemas: new Map(defEntries) };
  const declarations: string[] = [];
  const operations: string[] = [];

  for (const [name, schema] of defEntries) {
    declarations.push(
      `export type ${name} = ${typeOf(schema, ctx, `shared definition "${name}"`)};`,
    );
  }

  for (const [opName, opSchemas] of sortedEntries(schemas.operations)) {
    assertIdentifier(opName, "Operation");
    const base = pascalCase(opName);
    for (const suffix of ["Input", "Result", "Response"]) {
      claim(claimed, `${base}${suffix}`, `operation "${opName}"`);
    }

    declarations.push(
      `export type ${base}Input = ${typeOf(opSchemas.input, ctx, `the input of operation "${opName}"`)};`,
      `export type ${base}Result = ${outcomeUnion(opName, opSchemas.outcomes, ctx)};`,
      `export type ${base}Response = EnvelopeError | ({ readonly ok: true } & ${base}Result);`,
    );
    operations.push(
      `readonly ${opName}: { readonly input: ${base}Input; readonly result: ${base}Result };`,
    );
  }

  const source = [
    preamble(gatewayId),
    `import type { EnvelopeError, SecureValue } from "@repo/gateway-types";`,
    "",
    declarations.join("\n\n"),
    "",
    `export interface Operations { ${operations.join(" ")} }`,
    "",
    "export type OperationName = keyof Operations;",
    'export type OperationInput<TName extends OperationName> = Operations[TName]["input"];',
    'export type OperationResult<TName extends OperationName> = Operations[TName]["result"];',
    "export type OperationResponse<TName extends OperationName> =",
    "  | EnvelopeError",
    "  | ({ readonly ok: true } & OperationResult<TName>);",
    "",
    "// One call as the gateway receives it. `secure` carries the caller's asserted values; an",
    "// operation's secure bindings are compared against them, and the signature is not verified.",
    "export type GatewayRequest = {",
    "  readonly [TName in OperationName]: {",
    "    readonly operation: TName;",
    "    readonly input: OperationInput<TName>;",
    "    readonly secure: {",
    "      readonly values: Readonly<Record<string, SecureValue>>;",
    "      readonly signature: string;",
    "    };",
    "  };",
    "}[OperationName];",
  ].join("\n");

  await writeGenerated(
    clientDir,
    CONTRACT_MODULE,
    await formatSource(source, "typescript"),
  );
}
