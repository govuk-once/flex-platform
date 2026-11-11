// Key rotation's Lambda handler. The schedule invokes it with its own event, which asks for a run;
// a person invokes it with `{ "revoke": "<kid>" }` to remove a key at once.

import { isKeyId } from "@repo/frontdoor-shared";
import { describeUnexpectedError } from "@repo/utils/describe-unexpected-error";

import {
  KeyCheckFailed,
  rotate,
  type RotationPorts,
  type RotationRequest,
} from "./rotation.ts";

function requestOf(event: unknown): RotationRequest {
  if (typeof event === "object" && event !== null && "revoke" in event) {
    const { revoke } = event;
    if (typeof revoke !== "string" || !isKeyId(revoke)) {
      throw new Error("revoke must name a key ID");
    }
    return { revoke };
  }
  return {};
}

function log(
  level: "INFO" | "ERROR",
  event: string,
  details: Record<string, unknown>,
): void {
  console.log(
    JSON.stringify({
      level,
      message: "telemetry",
      telemetry: { event, details },
    }),
  );
}

export function createHandler(ports: RotationPorts, now: () => Date) {
  return async (event: unknown): Promise<void> => {
    try {
      const report = await rotate(ports, now(), requestOf(event));
      for (const { event: name, ...details } of report.events)
        log("INFO", name, details);
    } catch (error) {
      if (error instanceof KeyCheckFailed) {
        const { kid, reason, stored } = error;
        log("ERROR", "key_check_failed", { kid, reason, stored });
        throw error;
      }
      // The name is AWS's error code, such as AccessDeniedException, or Error. A message from
      // this module names only key IDs and accounts.
      log("ERROR", "key_rotation_failed", {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : undefined,
        frames: describeUnexpectedError(error).frames,
      });
      throw error;
    }
  };
}
