import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { DriverDefinition } from "@repo/gateway-config";
import type { GatewaySchemas } from "@repo/gateway-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AnyGatewayConfig } from "./load-config.ts";
import { loadConfig, loadGatewaySchemas, loadSchemas } from "./load-config.ts";

const driver: DriverDefinition = {
  type: "stub",
  createExecutor: () => Promise.reject(new Error("no executor")),
};

const config: AnyGatewayConfig = { id: "test", driver, operations: { op: {} } };

const fixture = `
export default {
  operations: {
    op: { input: { type: "object" }, outcomes: { ok: { type: "object" } } },
  },
};
`;

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "load-config-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("loadGatewaySchemas", () => {
  it("reads the gateway's fixture when the driver derives no schemas", async () => {
    await writeFile(path.join(tmp, "schemas.fixture.ts"), fixture);

    await expect(loadGatewaySchemas(config, tmp)).resolves.toEqual(
      await loadSchemas(tmp),
    );
  });

  it("prefers the driver's own description of the upstream", async () => {
    // A driver that derives schemas is asked for them; the fixture is not read.
    const derived: GatewaySchemas = { operations: {} };
    const seen: AnyGatewayConfig[] = [];
    const describing: AnyGatewayConfig = {
      ...config,
      driver: {
        ...driver,
        deriveSchemas: (given) => {
          seen.push(given);
          return Promise.resolve(derived);
        },
      },
    };

    await expect(loadGatewaySchemas(describing, tmp)).resolves.toBe(derived);
    expect(seen).toEqual([describing]);
  });
});

describe("loadConfig", () => {
  it("loads a gateway configuration written in TypeScript", async () => {
    await writeFile(
      path.join(tmp, "gateway.config.ts"),
      `const id: string = "loaded";\nexport default { id, operations: {} };\n`,
    );

    await expect(loadConfig(tmp)).resolves.toMatchObject({ id: "loaded" });
  });
});
