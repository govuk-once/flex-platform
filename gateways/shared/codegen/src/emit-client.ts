import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { assertGatewayId } from "@repo/gateway-core";
import { sortedNames } from "@repo/utils/sorted-names";
import { rolldown } from "rolldown";
import { dts } from "rolldown-plugin-dts";

import { CLIENT_ENTRY_MODULE, CONTRACT_MODULE, PACKAGE_DIR } from "./layout.ts";
import {
  assertIdentifier,
  formatSource,
  HEADER,
  writeGenerated,
} from "./output.ts";

// A gateway's client, as a package a domain installs: the gateway's call contract, and a
// function that creates a client typed by it. The client itself is the published gateway client,
// which the package names as its one peer, so a domain calling several gateways has one copy of
// it, one GatewayInvocationError and one caller context. The shared types the contract names are
// bundled in, since they are not published.

const CLIENT_PACKAGE = "@govuk-once/flex-gateway-client";
const SHARED_TYPES = "@repo/gateway-core";

// Resolved as this package resolves them, so a gateway needs neither as a dependency of its own.
const require = createRequire(import.meta.url);

/** The package is named from the gateway's id, so it refuses the ids its function name does. */
export function clientPackageName(gatewayId: string): string {
  assertGatewayId(gatewayId);
  return `@govuk-once/flex-gateway-${gatewayId}-client`;
}

/**
 * The function the package exports, named for the gateway so that a domain importing several
 * gateways' packages has no two exports of the same name.
 */
export function clientFactoryName(gatewayId: string): string {
  assertGatewayId(gatewayId);
  const name = `create${gatewayId
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}Client`;
  assertIdentifier(name, "Client factory");
  return name;
}

// A promise is anything with a `then` function, so a client holding one would be awaited as one:
// returned from an async function, it would be called in place of the client being returned.
const RESERVED_OPERATIONS = new Set(["then"]);

const entryModule = (id: string, operations: readonly string[]) => `
// The client for gateway ${JSON.stringify(id)}: its call contract, and a client typed by it.
import { createGatewayClient, type GatewayClient } from "${CLIENT_PACKAGE}";

import type { Operations } from "./${CONTRACT_MODULE}";

export type * from "./${CONTRACT_MODULE}";

/**
 * A client for the gateway ${JSON.stringify(id)}, with a function for each of its operations. It invokes the
 * gateway's function, named from its id and the environment \`FLEX_ENVIRONMENT\` names, in the
 * caller's own account and region.
 */
export function ${clientFactoryName(id)}(): GatewayClient<Operations> {
  return createGatewayClient<Operations>(${JSON.stringify(id)}, ${JSON.stringify(operations)});
}
`;

// Writes the client's entry point beside the contract it re-exports.
export async function emitClient(
  gatewayId: string,
  operations: readonly string[],
  clientDir: string,
): Promise<void> {
  for (const operation of operations) {
    if (RESERVED_OPERATIONS.has(operation)) {
      throw new Error(
        `An operation cannot be named ${JSON.stringify(operation)}: its client would be taken for a promise.`,
      );
    }
  }
  await writeGenerated(
    clientDir,
    CLIENT_ENTRY_MODULE,
    await formatSource(
      entryModule(gatewayId, sortedNames(operations)),
      "typescript",
    ),
  );
}

// The version of the gateway client this package is generated with.
async function sharedClientVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(require.resolve(`${CLIENT_PACKAGE}/package.json`), "utf-8"),
  ) as { readonly version: string };
  return manifest.version;
}

function majorOf(clientVersion: string): number {
  const match = /^(\d+)\.\d+\.\d+$/.exec(clientVersion);
  if (match === null) {
    throw new Error(
      `The gateway client's version ${JSON.stringify(clientVersion)} is not a release version.`,
    );
  }
  return Number(match[1]);
}

/**
 * The package's version: the gateway client's major, then the number of the gateway's latest
 * schema version. So a gateway's package changes minor exactly when its contract does, and
 * follows the client to a new major.
 */
export function clientPackageVersion(
  clientVersion: string,
  schemaVersion: string,
): string {
  if (!/^\d+$/.test(schemaVersion) || Number(schemaVersion) < 1) {
    throw new Error(
      `The schema version ${JSON.stringify(schemaVersion)} is not a version number.`,
    );
  }
  return `${majorOf(clientVersion)}.${Number(schemaVersion)}.0`;
}

/**
 * The gateway client this package is generated with, or any later release of the same major.
 * Spelled out, because under 1.0.0 a caret admits only the same minor.
 */
export function clientPeerRange(clientVersion: string): string {
  return `>=${clientVersion} <${majorOf(clientVersion) + 1}.0.0`;
}

// The package a domain installs, in the client directory's own `package/`: its manifest, the
// bundled module and its bundled declarations, built in one pass from the same entry point so the
// two cannot disagree about what is external.
export async function bundleClient(
  gatewayId: string,
  schemaVersion: string,
  clientDir: string,
): Promise<void> {
  const name = clientPackageName(gatewayId);
  const clientVersion = await sharedClientVersion();
  const version = clientPackageVersion(clientVersion, schemaVersion);
  const peers = { [CLIENT_PACKAGE]: clientPeerRange(clientVersion) };
  const external = Object.keys(peers);
  const packageDir = path.join(clientDir, PACKAGE_DIR);

  const build = await rolldown({
    // Module names in the output are relative to this, so they do not carry the directory the
    // build ran in.
    cwd: clientDir,
    input: { index: path.join(clientDir, CLIENT_ENTRY_MODULE) },
    platform: "node",
    external: (id) =>
      external.some((peer) => id === peer || id.startsWith(`${peer}/`)),
    resolve: { alias: { [SHARED_TYPES]: require.resolve(SHARED_TYPES) } },
    plugins: [
      // Declarations from each module's own annotations, read as rolldown reads the modules.
      // The compiler emits none for a file it reaches through node_modules, which is how the
      // workspace links the shared types.
      dts({ generator: "oxc", tsconfig: false }),
    ],
  });
  try {
    await build.write({
      dir: packageDir,
      format: "esm",
      entryFileNames: "[name].js",
      banner: HEADER.trimEnd(),
    });
  } finally {
    await build.close();
  }

  const manifest = {
    name,
    version,
    description: `The client for the Flex gateway "${gatewayId}".`,
    type: "module",
    exports: {
      ".": { types: "./index.d.ts", default: "./index.js" },
    },
    files: ["index.js", "index.d.ts"],
    sideEffects: false,
    peerDependencies: peers,
  };
  await writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
