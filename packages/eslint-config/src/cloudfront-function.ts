import type { Linter } from "eslint";

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

// The rules for code that runs in the CloudFront Functions runtime. It may import its own modules,
// the runtime's crypto, and the packages named in `allowedImports`, which are bundled into it.
export function cloudfrontFunction(
  allowedImports: readonly string[],
): Linter.Config {
  const allowed = [
    String.raw`\.{1,2}/`,
    "crypto$",
    ...allowedImports.map((name) => `${escapeRegExp(name)}$`),
  ];
  return {
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
      // The runtime provides crypto and nothing else. Anything bundled counts against 10 KB.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: `^(?!${allowed.join("|")})`,
              message: `Code for the CloudFront Functions runtime may import only its own modules, the runtime's crypto and ${allowedImports.length === 0 ? "nothing else" : allowedImports.join(", ")}.`,
            },
          ],
        },
      ],
    },
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
