import type { DriverDefinition } from "@repo/gateway-config";
import { defineGateway } from "@repo/gateway-config";

function openapiRest(config: {
  spec: string;
}): DriverDefinition<{ upstream: string }> {
  return { type: "openapi-rest", ...config };
}

export default defineGateway({
  id: "udp",
  description: "User Data Platform gateway",
  driver: openapiRest({
    spec: "https://raw.githubusercontent.com/govuk-once/user-data-platform/refs/heads/main/docs/openapi.yml",
  }),
  operations: {
    createUser: {
      description: "Create User Record",
      upstream: "POST /v1/user",
    },
    getIdentityExchange: {
      description: "Look up a linked identity record for a different service",
      upstream: "GET /v1/identity/exchange",
    },
  },
});
