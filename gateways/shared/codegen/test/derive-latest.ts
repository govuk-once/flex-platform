import type { DeriveSchemas } from "@repo/gateway-config";
import type { GatewaySchemas } from "@repo/gateway-types";

// A derivation for gateways whose versions are a test's own data rather than derived from
// anything: it answers with the latest of them, read through the sources as a driver's own
// derivation reads, so the gateway is always up to date and never gains a version.
const deriveLatest: DeriveSchemas = async (_config, sources) => {
  let latest: string | undefined;
  for (let n = 1; ; n += 1) {
    try {
      latest = await sources.load(`schemas/${String(n).padStart(4, "0")}.json`);
    } catch {
      break;
    }
  }
  if (latest === undefined) throw new Error("The gateway has no versions");
  return { schemas: JSON.parse(latest) as GatewaySchemas, notes: [] };
};

export default deriveLatest;
