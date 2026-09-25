import { driver } from "@repo/eslint-config";

const RUNTIME = {
  group: ["**/runtime/**"],
  allowTypeImports: true,
  message:
    "Only createExecutor reaches the runtime, and it imports it dynamically.",
};

// What a generated entry point imports ends up in the deployed gateway, a dynamic import
// included, and derive/ brings an OpenAPI parser with it. The definition names it instead.
const DERIVE = {
  group: ["**/derive/**", "@scalar/*"],
  message:
    "Nothing a gateway's configuration or runtime imports may reach derive/: the definition gives it as the deriveSchemasModule URL, so its parser is never bundled.",
};

// Codegen evaluates config/ and the shared modules; only createExecutor's dynamic import, which
// this rule does not see, reaches runtime/. Types may cross. Nothing but the command that
// updates a gateway's schemas reaches derive/, by the name the definition gives it.
export default [
  ...driver,
  {
    files: ["src/*.ts", "src/config/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [RUNTIME, DERIVE] },
      ],
    },
  },
  {
    files: ["src/runtime/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [DERIVE] },
      ],
    },
  },
  {
    files: ["src/derive/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [RUNTIME] },
      ],
    },
  },
];
