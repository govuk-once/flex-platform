import path from "node:path";

import eslint from "@eslint/js";
import { includeIgnoreFile } from "eslint/config";
import prettier from "eslint-plugin-prettier/recommended";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

import { findUpSync } from "./find-up.ts";

// Project only has one workspace file at the root
const rootDir = path.dirname(findUpSync("pnpm-workspace.yaml"));

export const base = tseslint.config(
  includeIgnoreFile(path.join(rootDir, ".gitignore")),
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    plugins: {
      "simple-import-sort": simpleImportSort,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: rootDir,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
    },
  },
);

// Drivers own transport access. Wrapping upstream calls in ctx.upstream is a contributor
// requirement; this preset does not enforce that wrapping.
export const driver = tseslint.config(...base);

// Services must not make network calls directly — all upstream access goes through a gateway.
const NETWORK_MESSAGE =
  "Services must not make network calls directly. Use a gateway.";

// Bare and node:-prefixed specifiers resolve to the same builtin, so ban both spellings.
const NETWORK_BUILTINS = ["http", "https", "http2", "net", "dgram", "tls"];

// Third-party clients a service might reach for instead. Not exhaustive; review transport
// dependencies separately.
const NETWORK_PACKAGES = ["undici"];

const NETWORK_GLOBALS = ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"];

export const service = tseslint.config(...base, {
  rules: {
    "no-restricted-globals": [
      "error",
      ...NETWORK_GLOBALS.map((name) => ({ name, message: NETWORK_MESSAGE })),
    ],
    "no-restricted-imports": [
      "error",
      {
        paths: [
          ...NETWORK_BUILTINS.flatMap((name) => [name, `node:${name}`]),
          ...NETWORK_PACKAGES,
        ].map((name) => ({ name, message: NETWORK_MESSAGE })),
      },
    ],
  },
});
