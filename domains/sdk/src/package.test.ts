import path from "node:path";

import { heldValue } from "@repo/utils/held-value";
import { rolldown } from "rolldown";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

import manifest from "../package.json" with { type: "json" };
import config from "../rolldown.config.ts";

// What a package's module or declarations import, a bare import included, sorted.
const imported = (source: string) =>
  [
    ...source.matchAll(
      /^\s*(?:import|export)\b(?:[^;"]*?\bfrom)?\s*"([^"]+)"/gm,
    ),
  ]
    .map((match) => match[1] ?? "")
    .toSorted();

const ROOT = path.join(import.meta.dirname, "..");

// Where the compiler is shown the published declarations: inside this package, so their imports
// of the peers resolve to its own copies, as a domain's resolve to the domain's.
const PUBLISHED = path.join(ROOT, "published", "index.d.ts");

const OPTIONS: ts.CompilerOptions = {
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

// A domain installs the package in a repository of its own, with nothing of this workspace, so the
// workspace's packages are bundled in and only the peers stay imports.
describe("the published package", () => {
  const files = new Map<string, string>();

  const read = (name: string) => heldValue(files, name);

  beforeAll(async () => {
    const { output, ...input } = config;

    const build = await rolldown(input);

    try {
      const { output: written } = await build.generate({
        ...(output as object),
      });

      for (const file of written) {
        if (file.type === "chunk") {
          files.set(file.fileName, file.code);
        } else {
          files.set(
            file.fileName,
            typeof file.source === "string"
              ? file.source
              : new TextDecoder().decode(file.source),
          );
        }
      }
    } finally {
      await build.close();
    }
  }, 60_000);

  // Compiles the fixture domain, and any extra modules beside it, with the package name resolved
  // to the published declarations, so nothing of src/ is read.
  function compile(extra: Readonly<Record<string, string>> = {}): string[] {
    const virtual = new Map<string, string>([
      [PUBLISHED, read("index.d.ts")],
      ...Object.entries(extra).map(([name, source]): [string, string] => [
        path.join(ROOT, "test", "fixtures", name),
        source,
      ]),
    ]);

    const host = ts.createCompilerHost(OPTIONS);

    const fileExists = host.fileExists.bind(host);

    const getSourceFile = host.getSourceFile.bind(host);

    host.fileExists = (file) => virtual.has(file) || fileExists(file);

    host.getSourceFile = (file, version, ...rest) => {
      const source = virtual.get(file);

      return source === undefined
        ? getSourceFile(file, version, ...rest)
        : ts.createSourceFile(file, source, version);
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
      rootNames: [
        path.join(ROOT, "test", "fixtures", "domain.ts"),
        ...virtual.keys(),
      ],
      options: OPTIONS,
      host,
    });

    expect(
      program
        .getSourceFiles()
        .some(({ fileName }) => fileName.startsWith(path.join(ROOT, "src"))),
    ).toBe(false);

    return ts
      .getPreEmitDiagnostics(program)
      .map(({ messageText }) =>
        ts.flattenDiagnosticMessageText(messageText, "\n"),
      );
  }

  it("imports only its peers", () => {
    expect(imported(read("index.js"))).toEqual(["zod"]);
    expect(imported(read("index.d.ts"))).toEqual(["zod"]);
  });

  it("types a domain with its declarations alone", () => {
    expect(compile()).toEqual([]);
  });

  it("still refuses a handler typed for another route", () => {
    const problems = compile({
      "mistake.ts": [
        'import { defineDomain } from "@govuk-once/flex-domain-sdk";',
        "",
        'import { getTodo } from "./routes/index.ts";',
        'import { TodoSchema } from "./schemas.ts";',
        "",
        "export const mistake = defineDomain({",
        '  name: "domain-a",',
        "  routes: {",
        '    "POST /v1/todos": { handler: getTodo, responses: { 201: TodoSchema } },',
        "  },",
        "});",
      ].join("\n"),
    });

    expect(problems).toEqual([
      expect.stringContaining(
        `Type 'Handler<"GET /v1/todos/{id}">' is not assignable`,
      ),
    ]);
  });

  it("has a manifest of its own, with no dependencies", () => {
    const published = JSON.parse(read("package.json")) as Record<
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
      peerDependencies: manifest.peerDependencies,
    });
  });
});
