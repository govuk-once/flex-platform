import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  clientFactoryName,
  clientPackageName,
  clientPackageVersion,
  clientPeerRange,
  emitClient,
} from "./emit-client.ts";

describe("clientPackageName", () => {
  it.each([
    ["udp", "@govuk-once/flex-gateway-udp-client"],
    ["dvla-licence", "@govuk-once/flex-gateway-dvla-licence-client"],
    ["v2", "@govuk-once/flex-gateway-v2-client"],
  ])("names the package for gateway %j", (id, name) => {
    expect(clientPackageName(id)).toBe(name);
  });

  it.each(["", "UDP", "udp_events", "2udp", "udp/../x", "@udp", "udp-"])(
    "refuses the gateway id %j",
    (id) => {
      expect(() => clientPackageName(id)).toThrow(
        `The gateway id ${JSON.stringify(id)} must be`,
      );
    },
  );
});

describe("clientFactoryName", () => {
  it.each([
    ["udp", "createUdpClient"],
    ["dvla-licence", "createDvlaLicenceClient"],
    ["v2", "createV2Client"],
    ["uns-2", "createUns2Client"],
  ])("names the factory for gateway %j", (id, name) => {
    expect(clientFactoryName(id)).toBe(name);
  });
});

describe("emitClient", () => {
  it("refuses an operation named then, which would make its client look like a promise", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "emit-client-"));
    try {
      await expect(
        emitClient("udp", ["getIdentity", "then"], dir),
      ).rejects.toThrow(
        'An operation cannot be named "then": its client would be taken for a promise.',
      );
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("clientPackageVersion", () => {
  it.each([
    ["0.1.0", "0001", "0.1.0"],
    ["0.1.0", "0010", "0.10.0"],
    ["0.4.2", "0003", "0.3.0"],
    ["1.11.0", "0012", "1.12.0"],
    ["1.0.0", "12345", "1.12345.0"],
  ])(
    "takes client %s's major and schema version %s's number",
    (client, schema, version) => {
      expect(clientPackageVersion(client, schema)).toBe(version);
    },
  );

  it.each(["0000", "", "1a", "-1", "1.0"])(
    "refuses the schema version %j",
    (schema) => {
      expect(() => clientPackageVersion("0.1.0", schema)).toThrow(
        `The schema version ${JSON.stringify(schema)} is not a version number.`,
      );
    },
  );

  it.each(["0.1", "0.1.0-rc.1", "v0.1.0", ""])(
    "refuses the client version %j",
    (client) => {
      expect(() => clientPackageVersion(client, "0001")).toThrow(
        `The gateway client's version ${JSON.stringify(client)} is not a release version.`,
      );
    },
  );
});

describe("clientPeerRange", () => {
  it.each([
    ["0.1.0", ">=0.1.0 <1.0.0"],
    ["0.10.3", ">=0.10.3 <1.0.0"],
    ["1.11.0", ">=1.11.0 <2.0.0"],
  ])("admits client %s and every later one of its major", (client, range) => {
    expect(clientPeerRange(client)).toBe(range);
  });
});
