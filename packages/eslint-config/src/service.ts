import { defineConfig } from "eslint/config";

import { base } from "./base.ts";

// Services must not make network calls directly — all upstream access goes through a gateway.
const NETWORK_MESSAGE =
  "Services must not make network calls directly. Use a gateway.";

// Bare and node:-prefixed specifiers resolve to the same builtin, so ban both spellings.
const NETWORK_BUILTINS = ["http", "https", "http2", "net", "dgram", "tls"];

// Third-party clients a service might reach for instead. Not exhaustive; review transport
// dependencies separately.
const NETWORK_PACKAGES = ["undici"];

const NETWORK_GLOBALS = ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"];

export const service = defineConfig(...base, {
  rules: {
    "no-restricted-globals": [
      "error",
      ...NETWORK_GLOBALS.map((name) => ({ name, message: NETWORK_MESSAGE })),
    ],
    "no-restricted-imports": [
      "error",
      {
        paths: [
          ...NETWORK_BUILTINS.flatMap((name) => [name, `node:${name}`]),
          ...NETWORK_PACKAGES,
        ].map((name) => ({ name, message: NETWORK_MESSAGE })),
      },
    ],
  },
});
