import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * The bundle codegen writes for a gateway, in its package, `@repo/gateway-service-<id>`. The app
 * depends on every gateway package config may deploy, which is how the synth waits on their
 * codegen. A gateway it doesn't depend on can't be found.
 */
export function gatewayBundle(gatewayId: string): string {
  const name = `@repo/gateway-service-${gatewayId}`;
  let manifest: string;
  try {
    manifest = require.resolve(`${name}/package.json`);
  } catch (error) {
    throw new Error(
      `The ${gatewayId} gateway's package, ${name}, isn't a dependency of @repo/infra-app. Add it there to deploy the gateway.`,
      { cause: error },
    );
  }
  return join(dirname(manifest), ".gen", "runtime", "bundle.mjs");
}
