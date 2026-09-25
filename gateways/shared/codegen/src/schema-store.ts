import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { GatewaySchemas } from "@repo/gateway-types";
import { isRecord } from "@repo/utils/is-record";
import { sortedNames } from "@repo/utils/sorted-names";

import { SCHEMAS_DIR } from "./layout.ts";

// A gateway's schemas as they are kept: one JSON file for each version, numbered from 0001 with
// nothing left out, the highest being the one a gateway is generated from. The width is fixed so
// that the names sort by code unit into the order they were written in, and the latest is found
// by comparing names rather than parsing them.

const VERSION_FILE = /^([0-9]{4})\.json$/;

const versionName = (index: number): string =>
  String(index + 1).padStart(4, "0");

// Everything wrong with a gateway's schemas directory or with one version in it, reported
// together: the command prints a message and nothing else, so one run has to say all of it.
export class SchemaStoreError extends Error {
  readonly problems: readonly string[];

  constructor(
    where: string,
    problems: readonly string[],
    options?: ErrorOptions,
  ) {
    super(
      [`${where}:`, ...problems.map((problem) => `  - ${problem}`)].join("\n"),
      options,
    );
    this.name = "SchemaStoreError";
    this.problems = problems;
  }
}

// The versions a gateway holds, oldest first. A directory that holds anything else, or whose
// numbers leave a gap, is refused rather than read around: a version is history, and a missing
// or a misnamed one is a history that no longer says what was generated from.
export async function schemaVersions(
  gatewayDir: string,
  // A gateway whose first version is about to be written has none, and no directory for them.
  { allowNone = false }: { readonly allowNone?: boolean } = {},
): Promise<string[]> {
  const dir = path.resolve(gatewayDir, SCHEMAS_DIR);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    if (allowNone && (cause as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new SchemaStoreError(
      dir,
      [
        `cannot be read; a gateway's schemas are kept in ${SCHEMAS_DIR}/${versionName(0)}.json and the versions after it`,
      ],
      { cause },
    );
  }

  const versions: string[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    // Dotted entries are what an editor or an operating system leaves behind, as the rest of a
    // gateway's directory is read.
    if (entry.name.startsWith(".")) continue;
    const version = entry.isFile()
      ? VERSION_FILE.exec(entry.name)?.[1]
      : undefined;
    if (version === undefined) {
      problems.push(
        `"${entry.name}" is not a version; a version is a file named as four digits, such as ${versionName(0)}.json`,
      );
    } else {
      versions.push(version);
    }
  }

  const found = sortedNames(versions);
  if (found.length === 0 && problems.length === 0 && !allowNone) {
    problems.push(`holds no versions; the first is ${versionName(0)}.json`);
  }
  found.forEach((version, index) => {
    if (version !== versionName(index) && problems.length === 0) {
      problems.push(
        `versions are numbered from ${versionName(0)} with none left out, and ${versionName(index)}.json is missing`,
      );
    }
  });

  if (problems.length > 0) throw new SchemaStoreError(dir, problems);
  return found;
}

// A name an object literal or an assignment reads as the prototype rather than as a property.
// JSON.parse makes it an ordinary key, so it is refused where a name becomes one of ours.
const UNUSABLE_NAME = "__proto__";

function checkNames(
  names: readonly string[],
  what: string,
  problems: string[],
): void {
  if (names.includes(UNUSABLE_NAME)) {
    problems.push(`${what} cannot be named "${UNUSABLE_NAME}"`);
  }
}

// The same name inside a schema, wherever it appears in one. A `properties` member of this name
// is skipped rather than compiled, a `required` entry naming it reads the prototype and so is
// never missing, and a standalone validator writes its schema back out as a JavaScript object
// literal, where the key sets the prototype and takes its value with it. Each of those leaves a
// schema that says one thing and checks another, so the name is refused throughout rather than
// in the positions one version of a validator generator happens to mishandle. Strings in a list
// are read as well as keys, since `required` and `dependentRequired` name a property as a string.
function checkSchema(value: unknown, where: string, problems: string[]): void {
  if (Array.isArray(value)) {
    if (value.includes(UNUSABLE_NAME)) {
      problems.push(`${where} cannot list "${UNUSABLE_NAME}"`);
    }
    value.forEach((item, index) => {
      checkSchema(item, `${where}[${index}]`, problems);
    });
    return;
  }

  if (!isRecord(value)) return;
  if (Object.hasOwn(value, UNUSABLE_NAME)) {
    problems.push(`${where} cannot declare "${UNUSABLE_NAME}"`);
  }
  for (const [name, member] of Object.entries(value)) {
    checkSchema(member, `${where}.${name}`, problems);
  }
}

function checkOnly(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  where: string,
  problems: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      problems.push(
        `${where} has an unknown field "${key}"; expected ${allowed.map((name) => `"${name}"`).join(" and ")}`,
      );
    }
  }
}

// A character that does not display: a control character, or one of the format characters that
// reorder or hide the text around them. A version is reviewed by a person and its text is written
// into generated code, so one of these would let it show a reviewer one thing and hold another.
// Tab and the line breaks are what a description is laid out with. Read from the parsed value,
// so one written as an escape is found as surely as one written as itself.
const HIDDEN = /(?![\t\n\r])[\p{Cc}\p{Cf}\u2028\u2029]/u;

const codePoint = (text: string): string => {
  const found = HIDDEN.exec(text)?.[0].codePointAt(0) ?? 0;
  return `U+${found.toString(16).toUpperCase().padStart(4, "0")}`;
};

function hiddenCharacters(
  value: unknown,
  where: string,
  problems: string[],
): void {
  if (typeof value === "string") {
    if (HIDDEN.test(value)) {
      problems.push(
        `${where} holds a character that does not display (${codePoint(value)})`,
      );
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      hiddenCharacters(item, `${where}.${String(index)}`, problems);
    });
  } else if (isRecord(value)) {
    for (const [key, held] of Object.entries(value)) {
      if (HIDDEN.test(key)) {
        problems.push(
          `${where} has a field whose name holds a character that does not display (${codePoint(key)})`,
        );
        continue;
      }
      hiddenCharacters(held, where === "" ? key : `${where}.${key}`, problems);
    }
  }
}

// A version is parsed, so nothing has checked it the way a compiler checks a module. What is
// established here is only that it has the shape the generator reads: whether a schema is a
// valid schema is Ajv's to say, and whether the operations are the configuration's is the
// check that follows. An unknown field is refused, since a misspelt one would otherwise be
// ignored and the gateway generated without it.
function shapeProblems(value: unknown): readonly string[] {
  if (!isRecord(value)) return ["must be a JSON object"];

  const problems: string[] = [];
  checkOnly(value, ["defs", "operations"], "the version", problems);

  if (Object.hasOwn(value, "defs")) {
    if (!isRecord(value.defs)) {
      problems.push(`"defs" must be an object of schemas`);
    } else {
      checkNames(Object.keys(value.defs), "a shared definition", problems);
      for (const [name, schema] of Object.entries(value.defs)) {
        if (isRecord(schema)) {
          checkSchema(schema, `defs.${name}`, problems);
        } else {
          problems.push(`defs.${name} must be a schema object`);
        }
      }
    }
  }

  if (!isRecord(value.operations)) {
    problems.push(`"operations" must be an object of operations`);
    return problems;
  }
  checkNames(Object.keys(value.operations), "an operation", problems);

  for (const [name, operation] of Object.entries(value.operations)) {
    const where = `operations.${name}`;
    if (!isRecord(operation)) {
      problems.push(`${where} must be an object`);
      continue;
    }
    checkOnly(operation, ["input", "outcomes"], where, problems);
    if (isRecord(operation.input)) {
      checkSchema(operation.input, `${where}.input`, problems);
    } else {
      problems.push(`${where}.input must be a schema object`);
    }
    if (!isRecord(operation.outcomes)) {
      problems.push(`${where}.outcomes must be an object of schemas`);
      continue;
    }
    checkNames(Object.keys(operation.outcomes), "an outcome", problems);
    for (const [outcome, schema] of Object.entries(operation.outcomes)) {
      if (isRecord(schema)) {
        checkSchema(schema, `${where}.outcomes.${outcome}`, problems);
      } else {
        problems.push(`${where}.outcomes.${outcome} must be a schema object`);
      }
    }
  }

  return problems;
}

// Everything wrong with schemas that are about to become a version, or were read as one: the
// shape the generator reads, and nothing in them that does not display.
export function schemasProblems(value: unknown): readonly string[] {
  const problems = [...shapeProblems(value)];
  hiddenCharacters(value, "", problems);
  return problems;
}

// One version, read from the bytes on disk each time it is asked for. Nothing is cached and
// nothing is evaluated, so a run always generates from what the file says now.
export async function readSchemas(
  gatewayDir: string,
  version: string,
): Promise<GatewaySchemas> {
  const file = path.resolve(gatewayDir, SCHEMAS_DIR, `${version}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf-8"));
  } catch (cause) {
    throw new SchemaStoreError(
      file,
      [
        `cannot be read as JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      ],
      { cause },
    );
  }

  const problems = schemasProblems(parsed);
  if (problems.length > 0) throw new SchemaStoreError(file, problems);
  return parsed as GatewaySchemas;
}

// One version as it was read, under the name it is kept by.
export interface SchemaVersion {
  readonly version: string;
  readonly schemas: GatewaySchemas;
}

// Every version a gateway holds, oldest first. The last is what it is generated from; the ones
// before it are what that has to remain compatible with.
export async function loadVersions(
  gatewayDir: string,
): Promise<readonly SchemaVersion[]> {
  const versions = await schemaVersions(gatewayDir);
  return Promise.all(
    versions.map(async (version) => ({
      version,
      schemas: await readSchemas(gatewayDir, version),
    })),
  );
}

// The version after the ones a gateway holds.
export const versionAfter = (versions: readonly string[]): string =>
  versionName(versions.length);

// Writes schemas as a version, in the order they were given: a version keeps the order its
// source was written in, so the contract lists an object's fields as the upstream documents
// them. Two-space JSON and nothing a formatter decides, so the same schemas are the same bytes
// whatever is installed. Written beside the file and moved into place, so a run that is
// interrupted leaves no half of a version behind for the next to generate from.
export async function writeVersion(
  gatewayDir: string,
  version: string,
  schemas: GatewaySchemas,
): Promise<string> {
  const dir = path.resolve(gatewayDir, SCHEMAS_DIR);
  const file = path.join(dir, `${version}.json`);
  // One staging file per run, created exclusively, and dotted so a run that dies here leaves
  // nothing the next one reads as a version. The name has to be this run's alone: linking makes
  // the published version and the staging file one inode, so a second run writing to a staging
  // file of the same name would write through the link and into what the first published, while
  // its own link failed and told it nothing had been written.
  const staged = path.join(dir, `.${version}.json.${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(staged, `${JSON.stringify(schemas, null, 2)}\n`, {
    flag: "wx",
  });
  try {
    // A link, not a rename: a rename replaces what is there, and a version is history. Linking
    // fails where the name is taken, in one step, so two runs cannot both write the same version.
    await link(staged, file);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    throw new SchemaStoreError(
      file,
      ["already exists; a version is never written over"],
      { cause },
    );
  } finally {
    await rm(staged, { force: true });
  }
  return file;
}
