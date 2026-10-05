import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { GatewaySchemas } from "@repo/gateway-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkDerivation, DerivationDriftError } from "./check-derivation.ts";
import { SCHEMAS_DIR } from "./layout.ts";
import { loadConfig } from "./load-config.ts";
import { loadVersions } from "./schema-store.ts";

// A gateway whose driver derives from what the gateway declares, in a file beside it: a case
// decides what the configuration declares by writing that file.
const CONFIG = `
export default {
  id: "declared",
  driver: {
    type: "stub",
    createExecutor: () => Promise.reject(new Error("no executor")),
    deriveSchemasModule: new URL("./derive.ts", import.meta.url).href,
  },
  operations: { getThing: {} },
};
`;

const DERIVE_DECLARED = `
export default async function derive(config, sources) {
  return { schemas: JSON.parse(await sources.load("declared.json")), notes: [] };
}
`;

const thing = (
  properties: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): GatewaySchemas => ({
  operations: {
    getThing: {
      input: { type: "object", properties: {}, additionalProperties: false },
      outcomes: {
        ok: { type: "object", properties, required: ["id"], ...extra },
      },
    },
  },
});

const COMMITTED = thing({ id: { type: "string" }, name: { type: "string" } });

let gatewayDir: string;

beforeEach(async () => {
  gatewayDir = await mkdtemp(
    path.join(import.meta.dirname, "..", "node_modules", ".derivation-"),
  );
  await writeFile(path.join(gatewayDir, "gateway.config.ts"), CONFIG);
  await writeFile(path.join(gatewayDir, "derive.ts"), DERIVE_DECLARED);
  await mkdir(path.join(gatewayDir, SCHEMAS_DIR));
  await writeFile(
    path.join(gatewayDir, SCHEMAS_DIR, "0001.json"),
    JSON.stringify(COMMITTED),
  );
});

afterEach(async () => {
  await rm(gatewayDir, { recursive: true, force: true });
});

const declares = (schemas: unknown) =>
  writeFile(path.join(gatewayDir, "declared.json"), JSON.stringify(schemas));

const check = async () =>
  checkDerivation(
    await loadConfig(gatewayDir),
    await loadVersions(gatewayDir),
    gatewayDir,
  );

async function refusal(): Promise<DerivationDriftError> {
  const error = await check().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DerivationDriftError);
  return error as DerivationDriftError;
}

describe("checkDerivation", () => {
  it("accepts a latest version that is what the driver derives", async () => {
    await declares(COMMITTED);
    await expect(check()).resolves.toBeUndefined();
  });

  it("reads a derivation as pnpm schemas does, so what it ignores passes here too", async () => {
    // A reworded description and a reordering write no version, so neither can fail generation:
    // there would be no version to write that made it pass.
    await declares(
      thing(
        {
          name: { type: "string", description: "Reworded" },
          id: { type: "string", title: "The id" },
        },
        { description: "Now described" },
      ),
    );
    await expect(check()).resolves.toBeUndefined();
  });

  it("refuses a declaration that has moved on, with what pnpm schemas would write", async () => {
    await declares(
      thing({
        id: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
      }),
    );

    const error = await refusal();
    expect(error.problems).toEqual([
      "0001 -> 0002: operations.getThing.outcomes.ok.properties.email: was added",
    ]);
    expect(error.message).toContain(
      "Run `pnpm schemas` to write the next version.",
    );
  });

  it("says when what the configuration declares would break a caller", async () => {
    await declares(thing({ id: { type: "string" } }));

    const error = await refusal();
    expect(error.problems).toEqual([
      "0001 -> 0002: operations.getThing.outcomes.ok.properties.name: was removed",
    ]);
    expect(error.message).toContain("needs a gateway of its own");
  });

  it("does not check a driver that has to fetch its upstream's description", async () => {
    // Generation runs without the network, so the read is refused before anything is fetched,
    // and a gateway that derives from an upstream is held by the comparison of its versions.
    await writeFile(
      path.join(gatewayDir, "derive.ts"),
      `export default async (config, sources) => ({
        schemas: JSON.parse(await sources.load("https://upstream.test/openapi.json")),
        notes: [],
      });\n`,
    );
    await expect(check()).resolves.toBeUndefined();
  });

  it("fails as the derivation fails, for anything but the network", async () => {
    await writeFile(
      path.join(gatewayDir, "derive.ts"),
      `export default () => Promise.reject(new Error("the configuration declares nothing"));\n`,
    );
    await expect(check()).rejects.toThrow("the configuration declares nothing");
  });
});
