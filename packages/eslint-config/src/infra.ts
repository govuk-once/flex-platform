import type { Linter } from "eslint";
import { defineConfig } from "eslint/config";

import { base } from "./base.ts";

// The infrastructure is layered, and imports run one way, so there are no cycles:
//
//   infra/constructs  ->  a section's infra/  ->  infra/app
//
// infra/constructs is what every section shares. A section's infra/ (frontdoor/infra, and later
// domains or gateways) builds on it and on its own section's code, never another section's.
// infra/app joins the sections, and nothing imports it. Packages outside the workspace are free.

const FILES = ["src/**/*.ts", "test/**/*.ts", "bin/**/*.ts"];

function restrictWorkspaceImports(
  allowed: readonly string[],
  message: string,
): Linter.Config {
  return {
    files: FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: `^@repo/(?!${allowed.join("|")})`,
              message,
            },
            { regex: "^@govuk-once/", message },
          ],
        },
      ],
    },
  };
}

/** For `infra/constructs`, the base layer: it imports no section and not the app. */
export const infraConstructs = defineConfig(
  ...base,
  restrictWorkspaceImports(
    ["utils/"],
    "infra/constructs is shared by every section, so it may import @repo/utils and nothing else from the workspace.",
  ),
);

/**
 * For a section's `infra/` package, such as `frontdoor/infra` with section `frontdoor`: it may
 * import `@repo/infra-constructs`, `@repo/utils` and its own section's `@repo/<section>-`
 * packages, and no other section's, nor the app.
 */
export function sectionInfra(section: string) {
  return defineConfig(
    ...base,
    restrictWorkspaceImports(
      ["infra-constructs$", "utils/", `${section}-`],
      `A section's infrastructure may import @repo/infra-constructs, @repo/utils and its own section's packages (@repo/${section}-*). Another section's names reach it as props, from infra/app.`,
    ),
  );
}
