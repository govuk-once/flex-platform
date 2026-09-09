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

// Drivers own their transport (fetch for REST, AWS SDK for DynamoDB, etc.) so the `driver`
// preset has no network restrictions. The structural enforcement is that drivers receive a
// `DriverContext` and must wrap upstream calls in `ctx.attempt`.
export const driver = tseslint.config(...base);

// Services must not make network calls directly — all upstream access goes through a gateway.
export const service = tseslint.config(...base, {
  rules: {
    "no-restricted-globals": [
      "error",
      {
        name: "fetch",
        message:
          "Services must not make network calls directly. Use a gateway.",
      },
    ],
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "node:http",
            message:
              "Services must not make network calls directly. Use a gateway.",
          },
          {
            name: "node:https",
            message:
              "Services must not make network calls directly. Use a gateway.",
          },
          {
            name: "undici",
            message:
              "Services must not make network calls directly. Use a gateway.",
          },
        ],
      },
    ],
  },
});
