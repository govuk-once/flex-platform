import path from "node:path";

import eslint from "@eslint/js";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import prettier from "eslint-plugin-prettier/recommended";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
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
      unicorn,
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
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "simple-import-sort/exports": "error",
      "simple-import-sort/imports": "error",
    },
  },
  {
    // Rules SonarQube runs on source, as S3358, S4138, S4624, S6582, S6598, S7755, S7758, S7763,
    // S7772, S7776, S7778, S7780 and S7786, so code it would flag fails lint first. It runs none
    // of them on what sonar-project.properties counts as tests.
    ignores: [
      "**/*.test.ts",
      "**/*.spec.ts",
      "**/__mocks__/**",
      "**/__tests__/**",
      "**/test/**",
    ],
    plugins: { sonarjs },
    rules: {
      "@typescript-eslint/prefer-for-of": "error",
      "@typescript-eslint/prefer-function-type": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "sonarjs/no-nested-conditional": "error",
      "sonarjs/no-nested-template-literals": "error",
      "unicorn/prefer-at": "error",
      "unicorn/prefer-code-point": "error",
      "unicorn/prefer-export-from": "error",
      "unicorn/prefer-node-protocol": "error",
      "unicorn/prefer-set-has": "error",
      "unicorn/prefer-single-call": "error",
      "unicorn/prefer-string-raw": "error",
      "unicorn/prefer-type-error": "error",
    },
  },
  {
    // The same check as SonarQube's S2699, so a test it would flag fails lint first.
    files: ["**/*.test.ts"],
    plugins: { sonarjs },
    rules: {
      "sonarjs/assertions-in-tests": "error",
    },
  },
);
