import { describe, expect, it } from "vitest";

import type { DomainConfig, RouteConfig } from "./config.ts";
import { validateDomain } from "./validate.ts";

const DOMAIN_CONFIG: DomainConfig = {
  name: "domain-one",
  routes: [
    { method: "GET", path: "/a" },
    { method: "PUT", path: "/a" },
  ],
};

function domainConfigWithRoutes(...routes: RouteConfig[]): DomainConfig {
  return { ...DOMAIN_CONFIG, routes };
}

function route(path: string, method: RouteConfig["method"] = "GET") {
  return { method, path };
}

describe("validateDomain", () => {
  it("accepts a domain left to the default access level", () => {
    expect(() => validateDomain(DOMAIN_CONFIG)).not.toThrow();
  });

  it.each(["isolated", "private", "public"] as const)(
    "accepts a domain at the %s access level",
    (access) => {
      expect(() => validateDomain({ ...DOMAIN_CONFIG, access })).not.toThrow();
    },
  );

  describe("names", () => {
    it.each(["d", "domain-1", `d${"x".repeat(31)}`])(
      "accepts the name %j",
      (name) => {
        expect(() => validateDomain({ ...DOMAIN_CONFIG, name })).not.toThrow();
      },
    );

    it.each([
      "",
      "Domain-One",
      "1domain",
      "domain-",
      "domain.one",
      `d${"x".repeat(32)}`,
    ])("refuses the name %j", (name) => {
      expect(() => validateDomain({ ...DOMAIN_CONFIG, name })).toThrow(
        `The domain name ${JSON.stringify(name)} must be 1 to 32 lowercase letters`,
      );
    });
  });

  describe("routes", () => {
    it("refuses a domain with no routes", () => {
      expect(() => validateDomain(domainConfigWithRoutes())).toThrow(
        "domain-one domain has no routes",
      );
    });

    it.each(["/", "/a", "/a/{id}", "/a/{id}/b", "/a.b/c_d/e-f"])(
      "accepts the path %j",
      (path) => {
        expect(() =>
          validateDomain(domainConfigWithRoutes(route(path))),
        ).not.toThrow();
      },
    );

    it("refuses a path that doesn't start with a slash", () => {
      expect(() => validateDomain(domainConfigWithRoutes(route("a")))).toThrow(
        'domain-one domain route "GET a": the path must start with "/"',
      );
    });

    it.each(["/a/", "//a", "/a//b"])(
      "refuses the empty segment in %j",
      (path) => {
        expect(() =>
          validateDomain(domainConfigWithRoutes(route(path))),
        ).toThrow("the path has an empty segment");
      },
    );

    it.each([
      ["a dot segment", "/a/./b", "."],
      ["a dot-dot segment", "/a/../b", ".."],
      ["an encoded slash", "/a%2Fb", "a%2Fb"],
      ["a space", "/a b", "a b"],
      ["a backslash", "/a\\b", "a\\b"],
      ["a query", "/a?b=c", "a?b=c"],
      ["an unclosed parameter", "/{id", "{id"],
      ["a parameter inside a segment", "/a-{id}", "a-{id}"],
      ["a parameter with a hyphen", "/{a-id}", "{a-id}"],
    ])("refuses %s", (_, path, segment) => {
      expect(() => validateDomain(domainConfigWithRoutes(route(path)))).toThrow(
        `${JSON.stringify(segment)} is not a valid path segment`,
      );
    });

    it.each(["/{proxy+}", "/a/{b+}"])(
      "refuses the greedy parameter in %j",
      (path) => {
        expect(() =>
          validateDomain(domainConfigWithRoutes(route(path))),
        ).toThrow("would answer every path below it");
      },
    );

    it("refuses a parameter used twice in one path", () => {
      expect(() =>
        validateDomain(domainConfigWithRoutes(route("/{id}/a/{id}"))),
      ).toThrow("the parameter {id} appears twice");
    });

    it("refuses a route declared twice", () => {
      expect(() =>
        validateDomain(domainConfigWithRoutes(route("/a"), route("/a"))),
      ).toThrow('"GET /a" can only be declared once');
    });

    it("accepts one path with several methods", () => {
      expect(() =>
        validateDomain(
          domainConfigWithRoutes(route("/a", "GET"), route("/a", "POST")),
        ),
      ).not.toThrow();
    });

    it("refuses two parameter names at the same place in the tree", () => {
      expect(() =>
        validateDomain(
          domainConfigWithRoutes(route("/a/{id}"), route("/a/{aId}/b")),
        ),
      ).toThrow(
        'domain-one domain route "GET /a/{aId}/b": {aId} sits beside {id} under /a',
      );
    });

    it("refuses two parameter names at the root", () => {
      expect(() =>
        validateDomain(domainConfigWithRoutes(route("/{a}"), route("/{b}"))),
      ).toThrow("{b} sits beside {a} under /,");
    });

    it("accepts one parameter name reused across routes, beside a literal", () => {
      expect(() =>
        validateDomain(
          domainConfigWithRoutes(
            route("/a/{id}"),
            route("/a/{id}/b"),
            route("/a/c"),
          ),
        ),
      ).not.toThrow();
    });
  });

  describe("function settings", () => {
    it.each([
      { timeoutSeconds: 1, memorySize: 128 },
      { timeoutSeconds: 29, memorySize: 10_240 },
    ])("accepts every setting at its limits: %j", (settings) => {
      expect(() =>
        validateDomain({ ...DOMAIN_CONFIG, function: settings }),
      ).not.toThrow();
    });

    it.each([0, 30, 1.5, Number.NaN])(
      "refuses a timeout of %j",
      (timeoutSeconds) => {
        expect(() =>
          validateDomain({ ...DOMAIN_CONFIG, function: { timeoutSeconds } }),
        ).toThrow(
          "domain-one domain function timeoutSeconds must be a whole number from 1 to 29",
        );
      },
    );

    it.each([127, 10_241, 256.5])(
      "refuses a memory size of %j",
      (memorySize) => {
        expect(() =>
          validateDomain({ ...DOMAIN_CONFIG, function: { memorySize } }),
        ).toThrow(
          "domain-one domain function memorySize must be a whole number from 128 to 10240",
        );
      },
    );
  });
});
