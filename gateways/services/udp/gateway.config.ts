import { defineGateway } from "@repo/gateway-config";
import {
  apiKey,
  fromSecret,
  openapiRest,
  sigV4,
} from "@repo/gateway-driver-openapi-rest";

import { DATA_STORE, stored } from "./config/data-store.ts";
import { GROUP_SUBSCRIPTIONS } from "./config/groups.ts";
import { NOTIFICATION_PREFERENCES } from "./config/notifications.ts";
import { REQUESTING } from "./config/requesting.ts";

export default defineGateway({
  id: "udp",
  description: "User Data Platform gateway",
  driver: openapiRest({
    // Pinned to a commit UDP has deployed to production, not to a branch: the schemas are derived
    // from what this names, and a branch names something else tomorrow. Moving it on to a later
    // one is how this gateway takes a newer UDP.
    spec: "https://raw.githubusercontent.com/govuk-once/user-data-platform/7ed6c9a3c57c06a64995eaae00195189f533926b/docs/openapi.yml",
    // Where UDP is and what Flex authenticates with are UDP's, in a secret UDP provides in its own
    // shape. Its API Gateway takes the key and a signature as the role UDP grants Flex, assumed
    // through STS; the key is set first, so the signature covers it.
    target: fromSecret("apiUrl"),
    auth: [
      apiKey({ header: "x-api-key", key: fromSecret("apiKey") }),
      sigV4({
        service: "execute-api",
        region: fromSecret("region"),
        role: {
          arn: fromSecret("consumerRoleArn"),
          // Present where the role's trust policy asks for one.
          externalId: fromSecret("externalId", { optional: true }),
          // The session Flex has always assumed the role as, so UDP's audit trail reads the same.
          sessionName: "consumer-session",
        },
      }),
    ],
  }),
  // Every operation UDP describes under a path of its own; and then what Flex keeps in UDP's data
  // store, which UDP describes once for any path, "/v1/{resourcePath+}", and any shape. Each of
  // those names its path in full, says that the template serves it, and states the shape Flex
  // keeps there, which is Flex's and not UDP's to describe. No caller chooses a path: what can be
  // reached is what is written here.
  operations: {
    createUser: {
      description: "Create User Record",
      upstream: "POST /v1/user",
    },
    getIdentityExchange: {
      description: "Look up a linked identity record for a different service",
      upstream: "GET /v1/identity/exchange",
      parameters: {
        requiredService: { in: "query" },
        ...REQUESTING,
      },
    },
    getIdentity: {
      description: "Read Identity Record",
      upstream: "GET /v1/identity/{serviceName}/{identifier}",
      parameters: {
        serviceName: { in: "path" },
        identifier: { in: "path" },
      },
    },
    createIdentity: {
      description: "Create Identity Record",
      upstream: "POST /v1/identity/{serviceName}/{identifier}",
      parameters: {
        serviceName: { in: "path" },
        identifier: { in: "path" },
      },
    },
    deleteIdentity: {
      description: "Delete Identity Record",
      upstream: "DELETE /v1/identity/{serviceName}/{identifier}",
      parameters: {
        serviceName: { in: "path" },
        identifier: { in: "path" },
      },
    },
    getLinkedServices: {
      description: "Get All Linked Services",
      upstream: "GET /v1/identity/{serviceName}/{identifier}/linked-services",
      parameters: {
        serviceName: { in: "path" },
        identifier: { in: "path" },
      },
    },
    startDsar: {
      description: "Start a DSAR Request",
      upstream: "POST /v1/dsar",
      parameters: REQUESTING,
    },
    startSar: {
      description: "Start a SAR Request",
      upstream: "POST /v1/sar",
      parameters: REQUESTING,
    },
    getNotificationPreferences: {
      description: "Read a user's notification preferences",
      upstream: "GET /v1/notifications",
      matches: DATA_STORE,
      parameters: REQUESTING,
      narrow: { outcomes: { ok: stored(NOTIFICATION_PREFERENCES) } },
    },
    updateNotificationPreferences: {
      description: "Create or replace a user's notification preferences",
      upstream: "POST /v1/notifications",
      matches: DATA_STORE,
      parameters: REQUESTING,
      narrow: {
        payload: stored(NOTIFICATION_PREFERENCES),
        outcomes: { ok: stored(NOTIFICATION_PREFERENCES) },
      },
    },
    deleteNotificationPreferences: {
      description: "Delete a user's notification preferences",
      upstream: "DELETE /v1/notifications",
      matches: DATA_STORE,
      parameters: REQUESTING,
    },
    getGroupSubscriptions: {
      description: "Read the groups a user is subscribed to",
      upstream: "GET /v1/groups",
      matches: DATA_STORE,
      parameters: REQUESTING,
      narrow: { outcomes: { ok: stored(GROUP_SUBSCRIPTIONS) } },
    },
    updateGroupSubscriptions: {
      description: "Replace the groups a user is subscribed to",
      upstream: "POST /v1/groups",
      matches: DATA_STORE,
      parameters: REQUESTING,
      narrow: {
        payload: stored(GROUP_SUBSCRIPTIONS),
        outcomes: { ok: stored(GROUP_SUBSCRIPTIONS) },
      },
    },
    getSarStatus: {
      description: "Get SAR Status",
      upstream: "GET /v1/sar/{sarId}",
      parameters: {
        sarId: { in: "path" },
        ...REQUESTING,
      },
    },
  },
});
