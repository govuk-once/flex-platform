import { defineGateway } from "@repo/gateway-config";
import { openapiRest } from "@repo/gateway-driver-openapi-rest";

import getIdentityExchange from "./handlers/get-identity-exchange.ts";

export default defineGateway({
  id: "udp",
  description: "User Data Platform gateway",
  driver: openapiRest({
    spec: "https://raw.githubusercontent.com/govuk-once/user-data-platform/refs/heads/main/docs/openapi.yml",
    // Sends no credential until this gateway is configured against UDP itself.
    auth: [],
  }),
  operations: {
    createUser: {
      description: "Create User Record",
      upstream: "POST /v1/user",
    },
    getIdentityExchange: {
      description: "Look up a linked identity record for a different service",
      upstream: "GET /v1/identity/exchange",
      parameters: { subjectId: { in: "query" } },
      handler: getIdentityExchange,
    },
  },
});
