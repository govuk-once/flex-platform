import { describe, expect, it } from "vitest";

import { ALLOWED_METHODS, uploadTarget } from "./route.ts";

describe("ALLOWED_METHODS", () => {
  it("is POST alone", () => {
    expect(ALLOWED_METHODS).toEqual(["POST"]);
  });
});

describe("uploadTarget", () => {
  it("reads the environment and the domain from the uploads route", () => {
    expect(
      uploadTarget("/ci/environments/development/domains/example/uploads"),
    ).toEqual({ environment: "development", domain: "example" });
  });

  it.each([
    "/",
    "/ci",
    "/ci/",
    "/ci/environments/development/domains/example",
    "/ci/environments/development/domains/example/uploads/",
    "/ci/environments/development/domains/example/uploads/extra",
    "/ci/environments/development/domains/example/releases",
    "/ci/environments//domains/example/uploads",
    "/ci/environments/development/domains//uploads",
    "/ci/environments/a/b/domains/example/uploads",
    "/ci/environments/development/domains/a/b/uploads",
    "/prefix/ci/environments/development/domains/example/uploads",
    "/CI/environments/development/domains/example/uploads",
  ])("finds no route in %s", (path) => {
    expect(uploadTarget(path)).toBeUndefined();
  });

  // Nothing is decoded, so an encoded slash is part of a name no config holds.
  it("takes each name as it is written", () => {
    expect(
      uploadTarget("/ci/environments/dev%2Fx/domains/__proto__/uploads"),
    ).toEqual({ environment: "dev%2Fx", domain: "__proto__" });
  });
});
