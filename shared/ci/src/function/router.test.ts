import { describe, expect, it } from "vitest";

import { createRouter, type RouteDefinition } from "./router.ts";
import { ROUTES } from "./routes/index.ts";

const handle: RouteDefinition["handle"] = () =>
  Promise.reject(new Error("unused"));

function route(method: string, path: string): RouteDefinition {
  return { method, path, handle };
}

const router = createRouter(ROUTES);

describe("createRouter", () => {
  it.each([
    ["uploads", 0],
    ["releases", 1],
  ])(
    "finds the %s route, with the environment and the domain its path names",
    (last, index) => {
      const found = router(
        "POST",
        `/ci/environments/development/domains/example/${last}`,
      );

      expect(found).toEqual({
        kind: "route",
        match: {
          route: ROUTES[index],
          params: new Map([
            ["environment", "development"],
            ["domain", "example"],
          ]),
        },
      });
    },
  );

  it("finds the status route, with the release's ID its path names", () => {
    const found = router(
      "GET",
      "/ci/environments/development/domains/example/releases/an-id",
    );

    expect(found).toEqual({
      kind: "route",
      match: {
        route: ROUTES[2],
        params: new Map([
          ["environment", "development"],
          ["domain", "example"],
          ["releaseId", "an-id"],
        ]),
      },
    });
  });

  it.each([
    "/",
    "/ci",
    "/ci/",
    "/ci/environments/development/domains/example",
    "/ci/environments/development/domains/example/uploads/",
    "/ci/environments/development/domains/example/uploads/extra",
    "/ci/environments/development/domains/example/releases/",
    "/ci/environments/development/domains/example/release",
    "/ci/environments/development/domains/example/promotions",
    "/ci/environments//domains/example/uploads",
    "/ci/environments/development/domains//uploads",
    "/ci/environments/a/b/domains/example/uploads",
    "/ci/environments/development/domains/a/b/uploads",
    "/prefix/ci/environments/development/domains/example/uploads",
    "/CI/environments/development/domains/example/uploads",
  ])("finds no route in %s, whatever the method", (path) => {
    expect(router("POST", path)).toEqual({ kind: "none" });
    expect(router("GET", path)).toEqual({ kind: "none" });
  });

  it.each(["GET", "PUT", "post"])(
    "says which methods a route's path takes, for %s",
    (method) => {
      expect(
        router(method, "/ci/environments/development/domains/example/uploads"),
      ).toEqual({ kind: "method", allowed: ["POST"] });
    },
  );

  it("lists every method a path takes", () => {
    const both = createRouter([
      route("POST", "/ci/{environment}/{domain}"),
      route("GET", "/ci/{environment}/{domain}"),
    ]);

    expect(both("DELETE", "/ci/development/example")).toEqual({
      kind: "method",
      allowed: ["POST", "GET"],
    });
  });

  // Nothing is decoded, so an encoded slash is part of a name no config holds.
  it("takes each parameter as it is written", () => {
    const found = router(
      "POST",
      "/ci/environments/dev%2Fx/domains/__proto__/uploads",
    );

    expect(found.kind === "route" && found.match.params).toEqual(
      new Map([
        ["environment", "dev%2Fx"],
        ["domain", "__proto__"],
      ]),
    );
  });

  it.each<[string, RouteDefinition[], string]>([
    [
      "two routes for the same method and path",
      [
        route("POST", "/ci/{environment}/{domain}"),
        route("POST", "/ci/{domain}/{environment}"),
      ],
      "Two routes",
    ],
    [
      "a path that names no domain",
      [route("POST", "/ci/{environment}")],
      "has no {domain}",
    ],
    [
      "a parameter named twice",
      [route("POST", "/ci/{environment}/{domain}/{domain}")],
      "twice",
    ],
    [
      "a path that isn't absolute",
      [route("POST", "ci/{environment}/{domain}")],
      "/",
    ],
  ])("refuses %s", (_, routes, message) => {
    expect(() => createRouter(routes)).toThrow(message);
  });
});
