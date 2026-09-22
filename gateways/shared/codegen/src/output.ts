import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { format } from "prettier";

export const HEADER =
  "// GENERATED FILE. Do not edit. Produced by @repo/gateway-codegen.\n";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function isIdentifier(name: string): boolean {
  return IDENTIFIER.test(name);
}

export function assertIdentifier(name: string, what: string): void {
  if (!isIdentifier(name)) {
    throw new Error(
      `${what} "${name}" is not a valid JavaScript identifier, so it cannot be used as an export name.`,
    );
  }
}

// Deterministic iteration. Output must not depend on key insertion order.
export function sortedEntries<T>(record: Record<string, T>): [string, T][] {
  return Object.keys(record)
    .sort()
    .map((key) => [key, record[key]!]);
}

export async function formatSource(
  source: string,
  parser: "babel" | "typescript",
): Promise<string> {
  try {
    return await format(source, { parser, printWidth: 100 });
  } catch (cause) {
    throw new Error("Generated output is not parseable", { cause });
  }
}

// Every emitted file carries the header, so no generated artifact reads as hand-written.
export async function writeGenerated(
  outDir: string,
  file: string,
  source: string,
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, file), HEADER + source);
}
