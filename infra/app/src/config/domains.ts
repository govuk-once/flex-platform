import type { DomainConfig } from "./types.ts";

// Every domain, once, with the repository that may release it. A domain account lists each one it
// hosts, as defined here, or with `disabled: true` added.

export const example: DomainConfig = {
  name: "example",
  repository: {
    name: "govuk-once/flex-platform-domain-sandbox",
    id: "1460189064",
    ownerId: "241280733",
  },
};
