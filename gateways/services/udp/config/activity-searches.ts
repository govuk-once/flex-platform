import type { JSONSchema } from "@repo/gateway-core";

// What Flex keeps under /v1/activity/searches: a user's recent searches, all of them at once.
// The fields are named as the records UDP already holds are.
export const ACTIVITY_SEARCHES: JSONSchema = {
  type: "object",
  properties: {
    searches: {
      type: "object",
      properties: {
        selectedSearches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              term: { type: "string", minLength: 1 },
              timestamp: { type: "string", format: "date-time" },
            },
            required: ["term", "timestamp"],
            additionalProperties: false,
          },
        },
      },
      required: ["selectedSearches"],
      additionalProperties: false,
    },
  },
  required: ["searches"],
  additionalProperties: false,
};
