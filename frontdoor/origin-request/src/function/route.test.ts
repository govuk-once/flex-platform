import { describe, expect, it } from "vitest";

import { routeFor } from "./route.ts";

const ROUTES = new Map([
  ["udp", "udp.development.flex-domain00.once.service.gov.uk"],
  ["dvla", "dvla.development.flex-domain00.once.service.gov.uk"],
]);

describe("routeFor", () => {
  it("routes a known domain to its host, with the rest of the path from its root", () => {
    expect(routeFor("/app/udp/v1/identity", ROUTES)).toEqual({
      domain: "udp",
      host: "udp.development.flex-domain00.once.service.gov.uk",
      path: "/v1/identity",
    });
  });

  it("gives a domain's root for the domain alone", () => {
    expect(routeFor("/app/dvla", ROUTES)).toEqual({
      domain: "dvla",
      host: "dvla.development.flex-domain00.once.service.gov.uk",
      path: "/",
    });
  });

  it("keeps the rest of the path as it was sent, escapes and all", () => {
    expect(routeFor("/app/udp/v1/a%20b", ROUTES)?.path).toBe("/v1/a%20b");
  });

  it.each([
    ["an unknown domain", "/app/unknown/v1"],
    ["a name an object inherits", "/app/constructor/v1"],
    ["a path outside /app", "/udp/v1"],
    ["the bare prefix", "/app/"],
  ])("routes nothing for %s", (_, uri) => {
    expect(routeFor(uri, ROUTES)).toBeUndefined();
  });

  it("routes nothing at all with no routes", () => {
    expect(routeFor("/app/udp/v1", new Map())).toBeUndefined();
  });
});
