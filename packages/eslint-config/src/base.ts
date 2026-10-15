import path from "node:path";

import eslint from "@eslint/js";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import prettier from "eslint-plugin-prettier/recommended";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

import { findUpSync } from "./find-up.ts";

// Project only has one workspace file at the root
const rootDir = path.dirname(findUpSync("pnpm-workspace.yaml"));

export const base = defineConfig(
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
      "@typescript-eslint/no-deprecated": "error",
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
    },
  },
);
