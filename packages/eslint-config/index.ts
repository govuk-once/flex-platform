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

// `driver` and `service` extend `base` with a hard ban on reaching the network directly.
// Every legitimate upstream call goes through the wrapped GatewayClient (via ctx.call), which
// is where timeouts, retries, breaker/budget accounting, auth and redaction live. A raw
// fetch/node:http/undici call bypasses all of that and still appears to work, so it is blocked
// here as a second line of defence alongside the structural seam.
export const driver = tseslint.config(...base, {
  rules: {
    "no-restricted-globals": [
      "error",
      {
        name: "fetch",
        message:
          "Use ctx.call(client => client.request(...)) instead of raw fetch.",
      },
    ],
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "node:http",
            message: "Use the wrapped GatewayClient instead.",
          },
          {
            name: "node:https",
            message: "Use the wrapped GatewayClient instead.",
          },
          { name: "undici", message: "Use the wrapped GatewayClient instead." },
        ],
      },
    ],
  },
});

// `service` currently mirrors `driver` (gateway services carry the same no-raw-network rule).
// Kept as its own export so the two can diverge later without changing what packages import.
export const service = driver;
