import { Linter } from "eslint";
import { describe, expect, it } from "vitest";

import { infraConstructs, sectionInfra } from "./infra.ts";

// The import rule alone: the presets' last entry. The rest is the base config, which needs a
// TypeScript project to run.
function restrictedImports(
  preset: readonly Linter.Config[],
  source: string,
  filename = "src/example.ts",
): string[] {
  const linter = new Linter({ configType: "flat" });
  const config = preset.at(-1);
  if (config === undefined) throw new Error("The preset is empty");
  return linter
    .verify(`import { x } from "${source}";\n`, [config], filename)
    .map((message) => message.ruleId ?? message.message);
}

describe("infraConstructs", () => {
  it.each([["@repo/utils/sorted-names"], ["aws-cdk-lib"], ["./bucket.ts"]])(
    "allows %s",
    (source) => {
      expect(restrictedImports(infraConstructs, source)).toEqual([]);
    },
  );

  it.each([
    ["@repo/infra-app"],
    ["@repo/frontdoor-infra"],
    ["@repo/gateway-runtime"],
    ["@govuk-once/flex-gateway-udp"],
  ])("refuses %s", (source) => {
    expect(restrictedImports(infraConstructs, source)).toEqual([
      "no-restricted-imports",
    ]);
  });
});

describe("sectionInfra", () => {
  const frontdoor = sectionInfra("frontdoor");

  it.each([
    ["@repo/infra-constructs"],
    ["@repo/utils/sorted-names"],
    ["@repo/frontdoor-shared"],
    ["@repo/frontdoor-origin-request"],
    ["aws-cdk-lib/aws-s3"],
  ])("allows %s", (source) => {
    expect(restrictedImports(frontdoor, source)).toEqual([]);
  });

  it.each([
    ["@repo/infra-app"],
    ["@repo/infra-constructs-extra"],
    ["@repo/domain-infra"],
    ["@repo/gateway-runtime"],
    ["@govuk-once/flex-gateway-udp"],
  ])("refuses %s", (source) => {
    expect(restrictedImports(frontdoor, source)).toEqual([
      "no-restricted-imports",
    ]);
  });

  it("applies to tests and leaves config files alone", () => {
    expect(
      restrictedImports(frontdoor, "@repo/infra-app", "test/helpers.ts"),
    ).toEqual(["no-restricted-imports"]);
    expect(
      restrictedImports(frontdoor, "@repo/eslint-config", "eslint.config.ts"),
    ).not.toContain("no-restricted-imports");
  });
});
