import type { JSONSchema } from "@repo/gateway-types";

// What Flex keeps under /v1/groups: the groups a user is subscribed to, all of them at once.
export const GROUP_SUBSCRIPTIONS: JSONSchema = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          Namespace: { type: "string" },
          Group: { type: "string" },
          Subgroup: { type: "string" },
          Type: { type: "string", enum: ["NOTIFICATION"] },
        },
        required: ["Namespace", "Group", "Type"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
  additionalProperties: false,
};
