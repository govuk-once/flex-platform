import type { PolicyConfig } from "./types.ts";

export const standardPolicy: PolicyConfig = {
  upstreamTimeout: "10s",
  circuitBreaker: { threshold: 5, duration: "120s" },
};
