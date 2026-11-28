// Key rotation's Lambda handler. The schedule invokes it with its own event, which asks for a run;
// a person invokes it with `{ "revoke": "<kid>" }` to remove a key at once, before the run.

import { logTelemetry } from "@repo/cloudfront-js-utils/log-telemetry";
import { isKeyId } from "@repo/frontdoor-shared";
import { describeUnexpectedError } from "@repo/utils/describe-unexpected-error";

import type { KeyPolicy } from "./policy.ts";
import { revoke } from "./revoke.ts";
import { KeyCheckFailed, rotate, type RotationPorts } from "./rotation.ts";

// The key a person asked to revoke, if the event names one.
function keyToRevoke(event: unknown): string | undefined {
  if (typeof event === "object" && event !== null && "revoke" in event) {
    const { revoke: keyId } = event;
    if (typeof keyId !== "string" || !isKeyId(keyId)) {
      throw new Error("revoke must name a key ID");
    }
    return keyId;
  }
  return undefined;
}

export function createHandler(
  ports: RotationPorts,
  policy: KeyPolicy,
  now: () => Date,
) {
  return async (event: unknown): Promise<void> => {
    try {
      const at = now();
      const keyId = keyToRevoke(event);
      if (keyId !== undefined) {
        // Written and logged before the run, which needs KMS: whatever the run then fails at,
        // the key has gone. The run reads the tables again, as the revocation left them.
        const { event: name, ...details } = await revoke(ports, at, keyId);
        logTelemetry("INFO", name, details);
      }
      const report = await rotate(ports, policy, at);
      for (const { event: name, ...details } of report.events)
        logTelemetry("INFO", name, details);
    } catch (error) {
      if (error instanceof KeyCheckFailed) {
        const { keyId, reason, stored } = error;
        logTelemetry("ERROR", "key_check_failed", { keyId, reason, stored });
        throw error;
      }
      // The name is AWS's error code, such as AccessDeniedException, or Error. A message from
      // this package names only key IDs, tables and kinds.
      logTelemetry("ERROR", "key_rotation_failed", {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : undefined,
        frames: describeUnexpectedError(error).frames,
      });
      throw error;
    }
  };
}
