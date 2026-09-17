import { driver } from "@repo/eslint-config";

// Codegen evaluates config/ and the shared modules; only createExecutor's dynamic import, which
// this rule does not see, reaches runtime/. Types may cross.
export default [
  ...driver,
  {
    files: ["src/*.ts", "src/config/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/runtime/**"],
              allowTypeImports: true,
              message:
                "Only createExecutor reaches the runtime, and it imports it dynamically.",
            },
          ],
        },
      ],
    },
  },
];
