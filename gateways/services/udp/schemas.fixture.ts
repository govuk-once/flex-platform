// Example schemas consumed by the codegen CLI. These are fixtures, not an upstream contract.
// Keep application code independent of this fixture module.

import type { GatewaySchemas } from "@repo/gateway-types";

import type gateway from "./gateway.config.ts";

// Keyed by the gateway's operations, so a missing or misnamed operation fails to typecheck.
type Operation = keyof (typeof gateway)["operations"];

export default {
  defs: {
    UserRecord: {
      type: "object",
      properties: {
        id: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
      },
      required: ["id"],
    },
  },

  operations: {
    createUser: {
      // The request body travels under `payload`; see the openapi-rest driver.
      input: {
        type: "object",
        properties: {
          payload: {
            type: "object",
            properties: { email: { type: "string" } },
            required: ["email"],
            additionalProperties: false,
          },
        },
        required: ["payload"],
        additionalProperties: false,
      },
      outcomes: {
        created: { $ref: "UserRecord" },
      },
    },

    getIdentityExchange: {
      input: {
        type: "object",
        properties: { subjectId: { type: "string" } },
        required: ["subjectId"],
        additionalProperties: false,
      },
      outcomes: {
        ok: {
          type: "object",
          properties: { linkedId: { type: "string" } },
          required: ["linkedId"],
        },
        // Returned by the custom handler when the upstream answers 404.
        unlinked: { type: "null" },
      },
    },
  },
} satisfies GatewaySchemas<Operation>;
