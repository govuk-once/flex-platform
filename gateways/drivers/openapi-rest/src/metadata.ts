import type { JSONSchema } from "@repo/gateway-types";
import { isRecord } from "@repo/utils/is-record";

import { normaliseHeaderName } from "./headers.ts";

// What a gateway reports about an exchange beside its result, and where this driver finds it:
// a response header, under a name of the gateway's choosing. A caller never sees the header's
// name, which is this transport's, only the name the gateway gave what it carries. The schema
// is the gateway's own and deliberately loose: an upstream that changes how its request ids
// look has changed nothing a caller relies on.
export interface ResponseMetadata {
  readonly header: string;
  readonly schema: JSONSchema;
}

export type MetadataConfig = Readonly<Record<string, ResponseMetadata>>;

type Scalar = "string" | "number" | "integer" | "boolean";

const SCALARS: readonly string[] = ["string", "number", "integer", "boolean"];

export interface CompiledMetadata {
  readonly name: string;
  // Lowercased, as the Headers class compares them.
  readonly header: string;
  readonly type: Scalar;
}

// Everything wrong with a driver's `metadata`, for the build-time check to report together and
// the executor to refuse to start on.
export function metadataProblems(metadata: unknown): readonly string[] {
  if (metadata === undefined) return [];
  if (!isRecord(metadata)) return ["Driver metadata must be an object"];
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(metadata)) {
    const where = `Driver metadata "${name}"`;
    if (!isRecord(entry) || typeof entry.header !== "string") {
      problems.push(`${where} must name the response header it is read from`);
      continue;
    }
    try {
      normaliseHeaderName(entry.header, where);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    if (
      !isRecord(entry.schema) ||
      !SCALARS.includes(entry.schema.type as string)
    ) {
      problems.push(
        `${where} must have a schema of one type, of ${SCALARS.join(", ")}`,
      );
    }
  }
  return problems;
}

export function compileMetadata(
  metadata: unknown,
): readonly CompiledMetadata[] {
  const problems = metadataProblems(metadata);
  if (problems.length > 0) throw new TypeError(problems.join("; "));
  return Object.entries((metadata ?? {}) as MetadataConfig).map(
    ([name, entry]) => ({
      name,
      header: normaliseHeaderName(entry.header, `Driver metadata "${name}"`),
      type: entry.schema.type as Scalar,
    }),
  );
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/;

// A header is text; what it carries may be a count or a flag. Read as its schema's type where
// the text is one, and left as text where it is not, for the gateway's validator to refuse.
function valueOf(text: string, type: Scalar): string | number | boolean {
  if ((type === "number" || type === "integer") && DECIMAL.test(text)) {
    return Number(text);
  }
  if (type === "boolean" && (text === "true" || text === "false")) {
    return text === "true";
  }
  return text;
}

// What a response carries of what the gateway reports. A header that is absent reports nothing.
export function readMetadata(
  headers: Headers,
  metadata: readonly CompiledMetadata[],
): readonly (readonly [string, string | number | boolean])[] {
  return metadata.flatMap(({ name, header, type }) => {
    const text = headers.get(header);
    return text === null ? [] : [[name, valueOf(text, type)] as const];
  });
}
