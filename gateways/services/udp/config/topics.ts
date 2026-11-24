import type { JSONSchema } from "@repo/gateway-core";

// What Flex keeps under /v1/topics: the topics a user has selected, all of them at once.
export const TOPICS: JSONSchema = {
  type: "object",
  properties: {
    topics: {
      type: "object",
      properties: {
        selectedTopics: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1 },
              title: { type: "string", minLength: 1 },
            },
            required: ["id", "title"],
            additionalProperties: false,
          },
        },
      },
      required: ["selectedTopics"],
      additionalProperties: false,
    },
  },
  required: ["topics"],
  additionalProperties: false,
};
