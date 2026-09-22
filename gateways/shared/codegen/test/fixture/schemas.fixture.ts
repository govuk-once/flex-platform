import type { GatewaySchemas } from "@repo/gateway-types";

import type gateway from "./gateway.config.ts";

type Operation = keyof (typeof gateway)["operations"];

export default {
  defs: {
    UserRecord: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  operations: {
    createUser: {
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
      outcomes: { created: { $ref: "UserRecord" } },
    },
  },
} satisfies GatewaySchemas<Operation>;
