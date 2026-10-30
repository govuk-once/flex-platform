import { describe, expect, it } from "vitest";

import { versionsFrom } from "./publish.ts";

// pnpm's own answers, as `pnpm view <name> versions --json` gives them.
describe("versionsFrom", () => {
  it("is every version published, however many there are", () => {
    expect(versionsFrom('"0.1.0"\n', "@govuk-once/a")).toEqual(["0.1.0"]);
    expect(
      versionsFrom('[\n  "0.1.0",\n  "0.2.0-rc.4"\n]\n', "@govuk-once/a"),
    ).toEqual(["0.1.0", "0.2.0-rc.4"]);
  });

  it("is none for a package that is not there", () => {
    const missing = (code: string) =>
      JSON.stringify({ error: { code, message: "Not Found" } });

    expect(
      versionsFrom(missing("ERR_PNPM_PACKAGE_NOT_FOUND"), "@govuk-once/a"),
    ).toEqual([]);
    expect(
      versionsFrom(missing("ERR_PNPM_FETCH_404"), "@govuk-once/a"),
    ).toEqual([]);
  });

  it("refuses an answer that is not versions", () => {
    expect(() => versionsFrom('[1, "0.1.0"]', "@govuk-once/a")).toThrow(
      "The registry gave no versions for @govuk-once/a",
    );
  });

  it("refuses any other error, such as a refused token", () => {
    const refused = JSON.stringify({ error: { code: "ERR_PNPM_FETCH_401" } });

    expect(() => versionsFrom(refused, "@govuk-once/a")).toThrow(
      "The registry gave no answer for @govuk-once/a",
    );
  });
});
