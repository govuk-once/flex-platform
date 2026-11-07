// Who is asking, which UDP takes as headers on everything it keeps or looks up for a user. One
// mapping for every operation that takes them, so a caller meets the same two fields wherever
// it meets them, named as the rest of an input is and not as the headers they travel in.
export const REQUESTING = {
  requestingService: { in: "header", name: "requesting-service" },
  requestingServiceUserId: {
    in: "header",
    name: "requesting-service-user-id",
  },
} as const;

// The user a call is for must be the one the caller token names, so a domain can only ever ask
// for its own caller's records. A user's ID is one in a service's namespace, so the service is
// held to the token's too: an ID read in another service's would name someone else, or no one.
export const FOR_CALLER = {
  requestingService: "service",
  requestingServiceUserId: "pairwiseId",
} as const;

// The same, for an operation that names the user by `identifier` under `serviceName`.
export const FOR_CALLER_BY_IDENTIFIER = {
  serviceName: "service",
  identifier: "pairwiseId",
} as const;

// The same, for an operation that names the user by the app ID it sends in its body.
export const FOR_CALLER_BY_APP_ID = { "payload.appId": "pairwiseId" } as const;
