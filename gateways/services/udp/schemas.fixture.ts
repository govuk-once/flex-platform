// Example schemas consumed by the codegen CLI. These are fixtures, not an upstream contract.
// Keep application code independent of this fixture module.

import type { GatewaySchemas } from "@repo/gateway-codegen";

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
      input: {
        type: "object",
        properties: { email: { type: "string" } },
        required: ["email"],
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
        record: {
          type: "object",
          properties: { linkedId: { type: "string" } },
          required: ["linkedId"],
        },
      },
    },
  },
} satisfies GatewaySchemas;
