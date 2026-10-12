import type { HostedDomainConfig } from "../types.ts";

export const example: HostedDomainConfig = {
  domainAccount: "domain00",
  config: {
    name: "example",
    routes: [
      { method: "GET", path: "/test" },
      { method: "PUT", path: "/test/{id}" },
    ],
  },
};
