import type { JSONSchema } from "@repo/gateway-core";

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
    // Not required of what is read. UDP keeps what it is sent as it is sent, whoever sent it, so
    // a record written without one is read back without one, and requiring it of a response
    // would make every read of that record an upstream contract violation.
    pushId: {
      type: "string",
      description: "The id notifications are pushed to",
    },
  },
  required: ["consentStatus"],
  additionalProperties: false,
};

// What a write must hold: the same, and always the ID, so the operation that writes it can bind
// it to the caller token's.
export const NOTIFICATION_PREFERENCES_WRITE: JSONSchema = {
  ...NOTIFICATION_PREFERENCES,
  required: ["consentStatus", "pushId"],
};
