import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { rolldown } from "rolldown";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import manifest from "../package.json" with { type: "json" };
import config from "../rolldown.config.ts";

const ROOT = path.join(import.meta.dirname, "..");

const FIXTURES = path.join(ROOT, "test", "fixtures");

// Where the compiler is shown the built declarations: inside this package, so their imports of the
// peers resolve to its own copies, as a domain's resolve to the domain's.
const PUBLISHED = path.join(ROOT, "published", "index.d.ts");

// A domain's own settings, as strict as the workspace's.
const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2024,
  allowImportingTsExtensions: true,
  noEmit: true,
  types: [],
};

interface Problem {
  readonly file: string;
  readonly message: string;
}

// A module beside the fixture domain that wires a handler to the wrong route.
const FILENAME = "mistake.ts";

const SOURCE = [
  'import { defineDomain } from "@govuk-once/flex-domain-sdk";',
  "",
  'import { getTodo } from "./routes/get-todo.ts";',
  'import { TodoSchema } from "./schemas.ts";',
  "",
  "export const mistake = defineDomain({",
  '  name: "domain-a",',
  "  routes: {",
  '    "POST /v1/todos": { handler: getTodo, responses: { 201: TodoSchema } },',
  "  },",
  "});",
].join("\n");

// What a module or declarations file imports, a bare import included.
const imported = (source: string) =>
  [
    ...source.matchAll(
      /^\s*(?:import|export)\b(?:[^;"]*?\bfrom)?\s*"([^"]+)"/gm,
    ),
  ].map((match) => match[1] ?? "");

describe("the published package", () => {
  let dist: string;

  const read = (name: string) => readFile(path.join(dist, name), "utf-8");

  // The compiler's problems with the fixture domain and the mistake beside it. One program is
  // compiled for both tests, since building one is most of their time.
  let problems: readonly Problem[];

  beforeAll(async () => {
    dist = await mkdtemp(path.join(os.tmpdir(), "domain-sdk-"));

    const { output, ...input } = config;

    const build = await rolldown(input);

    try {
      await build.write({ ...(output as object), dir: dist });
    } finally {
      await build.close();
    }

    problems = await compile({ [FILENAME]: SOURCE });
  }, 60_000);

  afterAll(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  // Compiles the fixture domain, and any modules given beside it, with the package's name resolved
  // to the built declarations. Returns the compiler's problems, and fails if anything in src/ was
  // read, so the declarations alone are what typed the domain.
  async function compile(
    extra: Readonly<Record<string, string>>,
  ): Promise<Problem[]> {
    const virtual = new Map<string, string>([
      [PUBLISHED, await read("index.d.ts")],
      ...Object.entries(extra).map(([name, source]): [string, string] => [
        path.join(FIXTURES, name),
        source,
      ]),
    ]);

    const host = ts.createCompilerHost(COMPILER_OPTIONS);

    const fileExists = host.fileExists.bind(host);

    const getSourceFile = host.getSourceFile.bind(host);

    host.fileExists = (file) => virtual.has(file) || fileExists(file);

    host.getSourceFile = (file, languageVersion, ...rest) => {
      const source = virtual.get(file);

      return source === undefined
        ? getSourceFile(file, languageVersion, ...rest)
        : ts.createSourceFile(file, source, languageVersion);
    };

    host.resolveModuleNameLiterals = (
      literals,
      containingFile,
      redirected,
      options,
      containingSourceFile,
    ) =>
      literals.map((literal) =>
        literal.text === manifest.name
          ? {
              resolvedModule: {
                resolvedFileName: PUBLISHED,
                extension: ts.Extension.Dts,
                isExternalLibraryImport: true,
              },
            }
          : ts.resolveModuleName(
              literal.text,
              containingFile,
              options,
              host,
              undefined,
              redirected,
              ts.getModeForUsageLocation(
                containingSourceFile,
                literal,
                options,
              ),
            ),
      );

    const program = ts.createProgram({
      rootNames: [path.join(FIXTURES, "domain.ts"), ...virtual.keys()],
      options: COMPILER_OPTIONS,
      host,
    });

    const fromSource = program
      .getSourceFiles()
      .map(({ fileName }) => fileName)
      .filter((fileName) => fileName.startsWith(path.join(ROOT, "src")));

    expect(fromSource).toEqual([]);

    return ts.getPreEmitDiagnostics(program).map(({ file, messageText }) => ({
      file: path.basename(file?.fileName ?? ""),
      message: ts.flattenDiagnosticMessageText(messageText, "\n"),
    }));
  }

  it("imports only its dependencies, its peers and Node's own modules", async () => {
    const packages = [
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.peerDependencies),
    ];

    for (const name of imported(await read("index.js"))) {
      const allowed =
        name.startsWith("node:") ||
        packages.some((pkg) => name === pkg || name.startsWith(`${pkg}/`));

      expect(allowed, `index.js imports ${name}`).toBe(true);
    }
  });

  it("types a domain with its declarations alone", () => {
    expect(problems.filter(({ file }) => file !== FILENAME)).toEqual([]);
  });

  it("still refuses a handler typed for another route", () => {
    expect(problems).toEqual([
      {
        file: FILENAME,
        message: expect.stringContaining(
          `Type 'Handler<"GET /v1/todos/{id}">' is not assignable`,
        ) as string,
      },
    ]);
  });

  it("has a manifest of its own, with its entry", async () => {
    const published = JSON.parse(await read("package.json")) as Record<
      string,
      unknown
    >;

    expect(published).toEqual({
      name: "@govuk-once/flex-domain-sdk",
      version: manifest.version,
      description: manifest.description,
      type: "module",
      exports: {
        ".": { types: "./index.d.ts", default: "./index.js" },
      },
      files: ["index.d.ts", "index.js"],
      sideEffects: false,
      dependencies: manifest.dependencies,
      peerDependencies: manifest.peerDependencies,
    });
  });
});
