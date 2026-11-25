// The package a domain installs, built into dist/ with its own manifest, which pnpm publishes in
// place of this one. The workspace's packages are bundled in, since they are not published. The
// peers stay imports, so a domain's schemas, its gateway calls and the SDK share the domain's own
// copy of each: one Zod for `instanceof`, and one caller context for every gateway call. The
// dependencies stay imports too, installed beside the SDK, as Pino loads modules of its own.

import { readFileSync } from "node:fs";
import path from "node:path";

import { sortedNames } from "@repo/utils/sorted-names";
import { defineConfig } from "rolldown";
import { dts } from "rolldown-plugin-dts";

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
}

const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "package.json"), "utf-8"),
) as Manifest;

const imported = [
  ...Object.keys(manifest.dependencies),
  ...Object.keys(manifest.peerDependencies),
];

// What a domain imports. More entries can sit beside it, each a chunk of its own.
const ENTRIES = ["index"] as const;

function sourceOf(entry: (typeof ENTRIES)[number]): string {
  return entry === "index"
    ? path.join(import.meta.dirname, "src", "index.ts")
    : path.join(import.meta.dirname, "src", entry, "index.ts");
}

export default defineConfig({
  // Module names in the output are relative to this, so they do not carry the directory the
  // build ran in.
  cwd: import.meta.dirname,
  input: Object.fromEntries(ENTRIES.map((entry) => [entry, sourceOf(entry)])),
  platform: "node",
  external: (id) =>
    imported.some((name) => id === name || id.startsWith(`${name}/`)),
  plugins: [
    // Declarations from each module's own annotations. The compiler emits none for a file it
    // reaches through node_modules, which is how the workspace links its packages.
    dts({ generator: "oxc", tsconfig: false }),
    {
      name: "manifest",
      generateBundle(_options, bundle) {
        this.emitFile({
          type: "asset",
          fileName: "package.json",
          source: `${JSON.stringify(
            {
              name: manifest.name,
              version: manifest.version,
              description: manifest.description,
              type: "module",
              exports: Object.fromEntries(
                ENTRIES.map((entry) => [
                  entry === "index" ? "." : `./${entry}`,
                  { types: `./${entry}.d.ts`, default: `./${entry}.js` },
                ]),
              ),
              files: sortedNames(Object.keys(bundle)),
              sideEffects: false,
              dependencies: manifest.dependencies,
              peerDependencies: manifest.peerDependencies,
            },
            null,
            2,
          )}\n`,
        });
      },
    },
  ],
  output: {
    dir: path.join(import.meta.dirname, "dist"),
    // The release packs and digests every file here, so nothing an earlier build wrote may stay.
    cleanDir: true,
    format: "esm",
    entryFileNames: "[name].js",
    // Named without a hash, so the package's files are the same from one build to the next.
    chunkFileNames: "[name].js",
  },
});
