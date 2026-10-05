import path from "node:path";

import type { SchemaSources } from "@repo/gateway-config";
import type { GatewaySchemas } from "@repo/gateway-types";

import { checkGateway } from "./check-gateway.ts";
import { checkVersions, compareCandidate } from "./compare-schemas.ts";
import { loadDerive } from "./derive-module.ts";
import { compileValidators } from "./emit-validators.ts";
import { SCHEMAS_DIR } from "./layout.ts";
import { type AnyGatewayConfig, loadConfig } from "./load-config.ts";
import { printable } from "./printable.ts";
import { schemaSources } from "./schema-sources.ts";
import {
  loadVersions,
  schemasProblems,
  SchemaStoreError,
  schemaVersions,
  versionAfter,
  writeVersion,
} from "./schema-store.ts";

// Brings a gateway's schemas up to date with its upstream, by hand: a person runs this, reads what
// it says and commits what it wrote. The driver is asked for the gateway's schemas, derived from
// its upstream's description or from what the configuration declares; what comes back is held to
// everything a version on disk is held to, and then to the latest version. It becomes the next
// version if and only if its shape changed and no change breaks a caller. A description that was
// reworded is not a change of shape, so it writes nothing: a version marks a contract a caller
// could tell from the last.

export type SchemasUpdate =
  | { readonly status: "unchanged"; readonly latest: string }
  | {
      readonly status: "written";
      readonly version: string;
      readonly changes: readonly string[];
    }
  // Nothing was written: the latest version stays what the gateway is generated from.
  | {
      readonly status: "breaking";
      readonly latest: string;
      readonly problems: readonly string[];
    };

export interface SchemasReport {
  readonly gatewayId: string;
  readonly update: SchemasUpdate;
  readonly notes: readonly string[];
}

// What a derived version is held to before it is written: its shape, each schema compiling as the
// validators compile it, and the configuration it has to agree with, the driver's own reading of
// that included. One reading, so a version is not written that the generator would fail.
function checkSchemas(
  config: AnyGatewayConfig,
  schemas: GatewaySchemas,
  where: string,
): void {
  const problems = schemasProblems(schemas);
  if (problems.length > 0) throw new SchemaStoreError(where, problems);
  compileValidators(schemas);
  checkGateway(config, schemas);
}

export async function updateSchemas(
  gatewayDir: string,
  sources: SchemaSources = schemaSources(gatewayDir),
): Promise<SchemasReport> {
  const dir = path.resolve(gatewayDir);
  const config = await loadConfig(dir);
  const deriveModule = config.driver.deriveSchemasModule;

  // Every driver derives its gateways' schemas, from an upstream's description or from what the
  // configuration declares, so no version is written by hand. The type requires the module; a
  // configuration that is not type-checked can still leave it out, and is refused as that.
  if (typeof deriveModule !== "string") {
    throw new TypeError(
      `Driver "${config.driver.type}" gives no deriveSchemasModule, so gateway "${config.id}" has nothing to derive its schemas with`,
    );
  }

  const derive = await loadDerive(deriveModule);
  const { schemas: candidate, notes } = await derive(config, sources);
  checkSchemas(
    config,
    candidate,
    `The schemas derived for gateway "${config.id}"`,
  );

  const names = await schemaVersions(dir, { allowNone: true });
  const latest = names.at(-1);
  if (latest === undefined) {
    const version = versionAfter(names);
    await writeVersion(dir, version, candidate);
    return {
      gatewayId: config.id,
      update: { status: "written", version, changes: ["the first version"] },
      notes,
    };
  }

  // The history is checked as codegen checks it, so a version is never added to one that is
  // already broken. The candidate is held to every version, as codegen will hold it once written;
  // what it changes is read against the latest alone, which it would follow.
  const versions = await loadVersions(dir);
  checkVersions(config.id, versions);
  const { breaking, changes: compatible } = compareCandidate(
    versionAfter(names),
    candidate,
    versions,
  );

  if (breaking.length > 0) {
    return {
      gatewayId: config.id,
      update: { status: "breaking", latest, problems: breaking },
      notes,
    };
  }
  if (compatible.length === 0) {
    return {
      gatewayId: config.id,
      update: { status: "unchanged", latest },
      notes,
    };
  }
  const version = versionAfter(names);
  await writeVersion(dir, version, candidate);
  return {
    gatewayId: config.id,
    update: { status: "written", version, changes: compatible },
    notes,
  };
}

const listed = (lines: readonly string[], mark: string): string[] =>
  lines.map((line) => `  ${mark} ${printable(line)}`);

// What a person reads. A break is said loudly and first, with what to do about it.
export function formatReport({
  gatewayId,
  update,
  notes,
}: SchemasReport): string {
  const file = (version: string) => `${SCHEMAS_DIR}/${version}.json`;
  const lines: string[] = [];
  switch (update.status) {
    case "unchanged":
      lines.push(
        `${gatewayId}: unchanged; ${file(update.latest)} is still what the gateway derives`,
      );
      break;
    case "written":
      lines.push(
        `${gatewayId}: wrote ${file(update.version)}`,
        ...listed(update.changes, "+"),
      );
      break;
    case "breaking":
      lines.push(
        // Not "upstream": a field the configuration renames breaks a caller as surely.
        `${gatewayId}: BREAKING CHANGE. Nothing was written; ${file(update.latest)} is still what the gateway is generated from, and no longer what its configuration and its upstream come to.`,
        ...listed(update.problems, "!"),
        "  A caller of the version each names first would not survive it. A contract that has to",
        "  break takes a gateway of its own, under another id.",
      );
      break;
  }
  if (notes.length > 0) lines.push("  notes:", ...listed(notes, "-"));
  return lines.join("\n");
}
