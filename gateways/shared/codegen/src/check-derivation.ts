import { compareCandidate } from "./compare-schemas.ts";
import { loadDerive } from "./derive-module.ts";
import type { AnyGatewayConfig } from "./load-config.ts";
import { OfflineSourceError, schemaSources } from "./schema-sources.ts";
import { type SchemaVersion, versionAfter } from "./schema-store.ts";

// Whether the latest version is still what the gateway's driver derives. Generation reads the
// committed version, not what it was derived from, so a configuration that declares its schemas
// and was changed since `pnpm schemas` last ran would otherwise generate from schemas it no longer
// declares. Read as `pnpm schemas` reads it, through compareCandidate: what that would write a
// version for fails here, and nothing else does, so a reworded description passes both.
//
// Derived without the network, since codegen runs in CI and never reaches an upstream. A driver
// that has to fetch its upstream's description cannot be derived here, and is not checked: its
// versions change when someone runs `pnpm schemas`, and the comparison of the versions holds them.

export class DerivationDriftError extends Error {
  readonly problems: readonly string[];

  constructor(gatewayId: string, problems: readonly string[], breaks: boolean) {
    super(
      [
        `Gateway "${gatewayId}" schemas are not what its driver derives:`,
        ...problems.map((problem) => `  - ${problem}`),
        breaks
          ? "Some of these would break a caller. An incompatible contract needs a gateway of its own, under another id."
          : "Run `pnpm schemas` to write the next version.",
      ].join("\n"),
    );
    this.name = "DerivationDriftError";
    this.problems = problems;
  }
}

function offline(error: unknown): boolean {
  for (let at = error; at instanceof Error; at = at.cause) {
    if (at instanceof OfflineSourceError) return true;
  }
  return false;
}

export async function checkDerivation(
  config: AnyGatewayConfig,
  versions: readonly SchemaVersion[],
  gatewayDir: string,
): Promise<void> {
  const latest = versions.at(-1);
  if (latest === undefined) return;

  const derive = await loadDerive(config.driver.deriveSchemasModule);
  let candidate;
  try {
    ({ schemas: candidate } = await derive(
      config,
      schemaSources(gatewayDir, { offline: true }),
    ));
  } catch (error) {
    if (offline(error)) return;
    throw error;
  }

  const next = versionAfter(versions.map(({ version }) => version));
  const { breaking, changes } = compareCandidate(next, candidate, versions);
  const problems = [
    ...breaking,
    ...changes.map((change) => `${latest.version} -> ${next}: ${change}`),
  ];
  if (problems.length > 0) {
    throw new DerivationDriftError(config.id, problems, breaking.length > 0);
  }
}
