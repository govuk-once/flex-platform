import type { SchemaSources } from "@repo/gateway-config";
import { isRecord } from "@repo/utils/is-record";
import { normalize, upgrade, validate } from "@scalar/openapi-parser";

// An upstream's OpenAPI document, read, checked and brought to one version. Parsing either
// format, checking it is a document at all and rewriting 3.0's dialect as 3.1's are the
// parser's; from here on a schema is JSON Schema 2020-12, whichever version the upstream wrote,
// which is the dialect the validators are built in.

export type OpenApiDocument = Readonly<Record<string, unknown>>;

export class OpenApiDeriveError extends Error {
  readonly problems: readonly string[];

  constructor(location: string, problems: readonly string[]) {
    super(
      [
        `Cannot derive schemas from ${location}:`,
        ...problems.map((problem) => `  - ${problem}`),
      ].join("\n"),
    );
    this.name = "OpenApiDeriveError";
    this.problems = problems;
  }
}

export async function loadDocument(
  location: string,
  sources: SchemaSources,
): Promise<OpenApiDocument> {
  const text = await sources.load(location);
  let parsed: unknown;
  try {
    parsed = normalize(text);
  } catch {
    // Nothing of the parser's own message: it quotes the text it could not read.
    throw new OpenApiDeriveError(location, ["it is neither JSON nor YAML"]);
  }
  if (!isRecord(parsed)) {
    throw new OpenApiDeriveError(location, ["it is not an OpenAPI document"]);
  }

  // The parser works on the object it is given, so each step is given one of its own.
  const checked = await validate(structuredClone(parsed));
  if (!checked.valid) {
    throw new OpenApiDeriveError(
      location,
      (checked.errors ?? []).map((error) => error.message),
    );
  }

  const { specification } = upgrade(structuredClone(parsed));
  if (!isRecord(specification)) {
    throw new OpenApiDeriveError(location, [
      "it could not be read as OpenAPI 3.1",
    ]);
  }
  return specification;
}

const COMPONENT = /^#\/components\/([^/]+)\/([^/]+)$/;

// A parameter, request body or response written as a reference to the document's own
// components. A schema is not resolved here: it keeps its name, as a shared definition.
export function resolved(
  document: OpenApiDocument,
  value: unknown,
  where: string,
  problems: string[],
): Readonly<Record<string, unknown>> | undefined {
  let current = value;
  for (let followed = 0; followed < 16; followed += 1) {
    if (!isRecord(current)) break;
    if (typeof current.$ref !== "string") return current;
    const [, section, name] = COMPONENT.exec(current.$ref) ?? [];
    const components = document.components;
    const held =
      section !== undefined &&
      name !== undefined &&
      isRecord(components) &&
      isRecord(components[section]) &&
      Object.hasOwn(components[section], name)
        ? components[section][name]
        : undefined;
    if (held === undefined) {
      problems.push(
        `${where} refers to "${current.$ref}", which is not in the document's own components`,
      );
      return undefined;
    }
    current = held;
  }
  problems.push(`${where} is not an object, or refers to itself`);
  return undefined;
}
