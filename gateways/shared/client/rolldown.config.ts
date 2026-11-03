// The package a domain installs, built into dist/ with its own manifest, which pnpm publishes in
// place of this one. The shared gateway types and utils are bundled in, since they are not
// published. The peers stay out, so a domain's own copy of the Lambda SDK serves every gateway's
// client and takes its fixes without a release of ours.

import { readFileSync } from "node:fs";
import path from "node:path";

import { sortedNames } from "@repo/utils/sorted-names";
import { defineConfig } from "rolldown";
import { dts } from "rolldown-plugin-dts";

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly peerDependencies: Readonly<Record<string, string>>;
}

const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "package.json"), "utf-8"),
) as Manifest;
const peers = Object.keys(manifest.peerDependencies);

export default defineConfig({
  // Module names in the output are relative to this, so they do not carry the directory the
  // build ran in.
  cwd: import.meta.dirname,
  // The SDK's entry apart from a domain's. What both use is one chunk they share, so a domain has
  // one caller context however its code reaches the client.
  input: {
    index: path.join(import.meta.dirname, "src", "index.ts"),
    caller: path.join(import.meta.dirname, "src", "caller.ts"),
  },
  platform: "node",
  external: (id) =>
    peers.some((peer) => id === peer || id.startsWith(`${peer}/`)),
  plugins: [
    // Declarations from each module's own annotations. The compiler emits none for a file it
    // reaches through node_modules, which is how the workspace links the shared types.
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
              exports: {
                ".": { types: "./index.d.ts", default: "./index.js" },
                "./caller": { types: "./caller.d.ts", default: "./caller.js" },
              },
              files: sortedNames(Object.keys(bundle)),
              sideEffects: false,
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
