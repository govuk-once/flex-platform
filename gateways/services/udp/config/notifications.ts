import type { JSONSchema } from "@repo/gateway-types";

// What Flex keeps under /v1/notifications: whether a user takes notifications, and where they
// are pushed to.
export const NOTIFICATION_PREFERENCES: JSONSchema = {
  type: "object",
  properties: {
    consentStatus: {
      type: "string",
      enum: ["unknown", "accepted", "denied"],
      description: "Whether the user has agreed to receive notifications",
    },
    // A user who has not registered a device has none to give, and UDP keeps what it is sent
    // as it is sent: a record written without one is read back without one. Requiring it of a
    // response would make every such record an upstream contract violation, on the write that
    // created it and on every read after.
    pushId: {
      type: "string",
      description: "The id notifications are pushed to",
    },
  },
  required: ["consentStatus"],
  additionalProperties: false,
};
