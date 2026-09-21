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
