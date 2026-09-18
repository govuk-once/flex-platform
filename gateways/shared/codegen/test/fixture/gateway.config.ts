import { defineGateway } from "@repo/gateway-config";

import { stubDriver } from "./driver.ts";

// Loaded by the generated entry point the way a real gateway's configuration is.
export default defineGateway({
  id: "fixture",
  driver: stubDriver(),
  operations: {
    createUser: { log: { input: ["payload.email"] } },
  },
});
