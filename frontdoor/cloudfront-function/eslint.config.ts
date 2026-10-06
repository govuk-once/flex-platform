import { base } from "@repo/eslint-config";
import { defineConfig } from "eslint/config";

// The cloudfront-js-2.0 runtime, from CloudFront's list of what it supports. esbuild rewrites
// syntax the runtime lacks, but not built-ins: Node has these, so the tests pass, and the function
// fails only in CloudFront.
const RUNTIME = "The cloudfront-js-2.0 runtime doesn't have this.";

const MISSING_GLOBALS = [
  "AbortController",
  "Intl",
  "Map",
  "Proxy",
  "Reflect",
  "Set",
  "URL",
  "URLSearchParams",
  "WeakMap",
  "WeakSet",
  "clearInterval",
  "clearTimeout",
  "fetch",
  "process",
  "queueMicrotask",
  "require",
  "setImmediate",
  "setInterval",
  "setTimeout",
  "structuredClone",
];

const MISSING_PROPERTIES = [
  { object: "Array", property: "from" },
  { object: "Object", property: "fromEntries" },
  { object: "Object", property: "hasOwn" },
  { property: "at" },
  { property: "flat" },
  { property: "flatMap" },
];

export default defineConfig(...base, {
  files: ["src/function/**/*.ts"],
  ignores: ["**/*.test.ts"],
  rules: {
    "no-eval": "error",
    "no-new-func": "error",
    "no-console": ["error", { allow: ["log"] }],
    "no-restricted-globals": [
      "error",
      ...MISSING_GLOBALS.map((name) => ({ name, message: RUNTIME })),
    ],
    "no-restricted-properties": [
      "error",
      ...MISSING_PROPERTIES.map((rule) => ({ ...rule, message: RUNTIME })),
    ],
    "no-restricted-syntax": [
      "error",
      {
        selector: "ForOfStatement",
        message: `${RUNTIME} Nor can esbuild rewrite it: use an index loop.`,
      },
      {
        selector:
          "CallExpression[callee.object.name='console'][arguments.length>1]",
        message: "The runtime's console.log takes one argument. Concatenate.",
      },
    ],
    // The runtime provides crypto and nothing else here; anything bundled counts against 10 KB.
    // The one exception is the rule for names in the infra's config, so the two can't drift.
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            regex: "^(?!\\.{1,2}/|crypto$|@repo/utils/is-platform-name$)",
            message:
              "The function may import only its own modules, the runtime's crypto and isPlatformName.",
          },
        ],
      },
    ],
  },
});
