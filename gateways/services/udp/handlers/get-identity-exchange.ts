import { defineHandler } from "@repo/gateway-driver-openapi-rest";

// The upstream answers 404 when nothing is linked yet. That is an answer for callers, not an
// error, so it becomes the `unlinked` outcome here instead of surfacing as NOT_FOUND.
export default defineHandler(async (input: { subjectId: string }, client) => {
  const response = await client.request(client.prepare(input));
  if (response.status === 404) {
    return { outcome: "unlinked", data: null };
  }
  return client.mapResponse(response);
});
