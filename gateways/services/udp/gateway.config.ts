import type { DriverDefinition } from "@repo/gateway-config";
import { defineGateway } from "@repo/gateway-config";

function openapiRest(config: {
  spec: string;
}): DriverDefinition<{ upstream: string }> {
  return {
    type: "openapi-rest",
    // A placeholder until the openapi-rest driver package supplies the definition. Codegen
    // loads this configuration; nothing here creates an executor.
    createExecutor: () =>
      Promise.reject(new Error("The openapi-rest driver is not implemented")),
    ...config,
  };
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
