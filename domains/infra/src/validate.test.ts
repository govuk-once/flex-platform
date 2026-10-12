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

// The longest environment name a 32-character domain name fits beside: domain-{24}-{32} is 64.
const ENVIRONMENT = "e".repeat(24);

const LONGEST_NAME = `d${"x".repeat(31)}`;

function validate(domain: DomainConfig): void {
  validateDomain(domain, { environment: ENVIRONMENT });
}

function route(path: string, method: RouteConfig["method"] = "GET") {
  return { method, path };
}

describe("validateDomain", () => {
  it("accepts a domain left to the default access level", () => {
    expect(() => validate(DOMAIN_CONFIG)).not.toThrow();
  });

  it.each(["isolated", "private", "public"] as const)(
    "accepts a domain at the %s access level",
    (access) => {
      expect(() => validate({ ...DOMAIN_CONFIG, access })).not.toThrow();
    },
  );

  describe("names", () => {
    // domain-{environment}-{name} names the function and its role, which allow 64 characters.
    it("accepts a name whose resource name is 64 characters", () => {
      expect(`domain-${ENVIRONMENT}-${LONGEST_NAME}`).toHaveLength(64);
      expect(() =>
        validate({ ...DOMAIN_CONFIG, name: LONGEST_NAME }),
      ).not.toThrow();
    });

    it("refuses a name whose resource name is longer than 64 characters", () => {
      const environment = `${ENVIRONMENT}e`;

      expect(() =>
        validateDomain(
          { ...DOMAIN_CONFIG, name: LONGEST_NAME },
          { environment },
        ),
      ).toThrow(
        `${LONGEST_NAME} domain: its resource name, domain-${environment}-${LONGEST_NAME}, is longer than the 64 characters Lambda and IAM allow`,
      );
    });

    it.each(["d", "domain-1", LONGEST_NAME])("accepts the name %j", (name) => {
      expect(() => validate({ ...DOMAIN_CONFIG, name })).not.toThrow();
    });

    it.each([
      "",
      "Domain-One",
      "1domain",
      "domain-",
      "domain.one",
      `d${"x".repeat(32)}`,
    ])("refuses the name %j", (name) => {
      expect(() => validate({ ...DOMAIN_CONFIG, name })).toThrow(
        `The domain name ${JSON.stringify(name)} must be 1 to 32 lowercase letters`,
      );
    });
  });

  describe("routes", () => {
    it("refuses a domain with no routes", () => {
      expect(() => validate(domainConfigWithRoutes())).toThrow(
        "domain-one domain has no routes",
      );
    });

    it.each(["/", "/a", "/a/{id}", "/a/{id}/b", "/a.b/c_d/e-f"])(
      "accepts the path %j",
      (path) => {
        expect(() =>
          validate(domainConfigWithRoutes(route(path))),
        ).not.toThrow();
      },
    );

    it("refuses a path that doesn't start with a slash", () => {
      expect(() => validate(domainConfigWithRoutes(route("a")))).toThrow(
        'domain-one domain route "GET a": the path must start with "/"',
      );
    });

    it.each(["/a/", "//a", "/a//b"])(
      "refuses the empty segment in %j",
      (path) => {
        expect(() => validate(domainConfigWithRoutes(route(path)))).toThrow(
          "the path has an empty segment",
        );
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
      expect(() => validate(domainConfigWithRoutes(route(path)))).toThrow(
        `${JSON.stringify(segment)} is not a valid path segment`,
      );
    });

    it.each(["/{proxy+}", "/a/{b+}"])(
      "refuses the greedy parameter in %j",
      (path) => {
        expect(() => validate(domainConfigWithRoutes(route(path)))).toThrow(
          "would answer every path below it",
        );
      },
    );

    it("refuses a parameter used twice in one path", () => {
      expect(() =>
        validate(domainConfigWithRoutes(route("/{id}/a/{id}"))),
      ).toThrow("the parameter {id} appears twice");
    });

    it("refuses a route declared twice", () => {
      expect(() =>
        validate(domainConfigWithRoutes(route("/a"), route("/a"))),
      ).toThrow('"GET /a" can only be declared once');
    });

    it("accepts one path with several methods", () => {
      expect(() =>
        validate(
          domainConfigWithRoutes(route("/a", "GET"), route("/a", "POST")),
        ),
      ).not.toThrow();
    });

    it("refuses two parameter names at the same place in the tree", () => {
      expect(() =>
        validate(domainConfigWithRoutes(route("/a/{id}"), route("/a/{aId}/b"))),
      ).toThrow(
        'domain-one domain route "GET /a/{aId}/b": {aId} sits beside {id} under /a',
      );
    });

    it("refuses two parameter names at the root", () => {
      expect(() =>
        validate(domainConfigWithRoutes(route("/{a}"), route("/{b}"))),
      ).toThrow("{b} sits beside {a} under /,");
    });

    it("accepts one parameter name reused across routes, beside a literal", () => {
      expect(() =>
        validate(
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
        validate({ ...DOMAIN_CONFIG, function: settings }),
      ).not.toThrow();
    });

    it.each([0, 30, 1.5, Number.NaN])(
      "refuses a timeout of %j",
      (timeoutSeconds) => {
        expect(() =>
          validate({ ...DOMAIN_CONFIG, function: { timeoutSeconds } }),
        ).toThrow(
          "domain-one domain function timeoutSeconds must be a whole number from 1 to 29",
        );
      },
    );

    it.each([127, 10_241, 256.5])(
      "refuses a memory size of %j",
      (memorySize) => {
        expect(() =>
          validate({ ...DOMAIN_CONFIG, function: { memorySize } }),
        ).toThrow(
          "domain-one domain function memorySize must be a whole number from 128 to 10240",
        );
      },
    );
  });
});
