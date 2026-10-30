import { execFile as execFileCb } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLIENT,
  fixtureWorkspace,
  gateway,
  readJson,
  SDK,
  setFile,
} from "../test/fixture.ts";
import { type Chooser, prepare, releaseAll } from "./prepare.ts";
import {
  packRelease,
  PLAN_FILE,
  publishRelease,
  type Registry,
} from "./publish.ts";
import { readRecord, RECORD_FILE } from "./record.ts";
import type { History } from "./status.ts";
import { verifyRelease } from "./verify.ts";
import type { Workspace } from "./workspace.ts";

// A release from end to end, against the fixture workspace: preparing it, packing what a merge
// publishes, and publishing a stage.

let workspace: Workspace;

beforeEach(async () => {
  workspace = await fixtureWorkspace();
});

afterEach(async () => {
  await rm(workspace.root, { recursive: true, force: true });
});

const noHistory: History = () => Promise.resolve([]);

// Answers as given, and remembers what it was asked, and what its answer brings with it.
function chooser(answers: { select?: readonly string[] }) {
  const asked = {
    pending: [] as string[],
    next: {} as Record<string, string>,
    locked: new Map<string, string>(),
  };
  const choose: Chooser = {
    select: (choices, lock) => {
      const pending = choices.filter((c) => c.reason !== undefined);
      asked.pending = pending.map((c) => c.pkg.built.name);
      asked.next = Object.fromEntries(
        pending.map((c) => [c.pkg.built.name, c.next]),
      );
      const answer = new Set(answers.select ?? asked.pending);
      asked.locked = new Map(lock(answer));
      return Promise.resolve(answer);
    },
  };
  return { choose, asked };
}

const change = (file: string, text = "export const changed = true;\n") =>
  setFile(workspace.root, file, text);

const readText = (file: string) =>
  readFile(path.join(workspace.root, file), "utf-8");

async function released(): Promise<Record<string, string>> {
  return Object.fromEntries(
    [...(await readRecord(workspace.root))].map(([name, { version }]) => [
      name,
      version,
    ]),
  );
}

const firstRelease = () => prepare(workspace, releaseAll, noHistory);

describe("prepare", () => {
  it("releases every package at its own version the first time, each after what it depends on", async () => {
    const planned = await firstRelease();

    expect(planned.map((p) => `${p.name}@${p.to}`)).toEqual([
      `${CLIENT}@0.1.0`,
      `${gateway("a")}@0.1.0`,
      `${gateway("b")}@0.1.0`,
      `${SDK}@0.1.0`,
    ]);
    expect(planned[0]).toMatchObject({
      from: undefined,
      reason: "not released yet",
    });
    expect(await released()).toEqual({
      [CLIENT]: "0.1.0",
      [gateway("a")]: "0.1.0",
      [gateway("b")]: "0.1.0",
      [SDK]: "0.1.0",
    });
  });

  it("finds nothing to release when nothing changed since the last release", async () => {
    await firstRelease();
    const record = await readText(RECORD_FILE);

    expect(await prepare(workspace, releaseAll, noHistory)).toEqual([]);
    expect(await readText(RECORD_FILE)).toBe(record);
  });

  it("releases a changed gateway as a patch, and a new schema as a new minor", async () => {
    await firstRelease();
    await change("gateways/a/src.js");
    await change("gateways/b/schema", "2\n");

    expect(await prepare(workspace, releaseAll, noHistory)).toEqual([
      {
        name: gateway("a"),
        from: "0.1.0",
        to: "0.1.1",
        reason: "contents changed",
      },
      { name: gateway("b"), from: "0.1.0", to: "0.2.0", reason: "new schema" },
    ]);
  });

  it("releases only what is chosen, when nothing else depends on it or is built into it", async () => {
    await firstRelease();
    await change("gateways/a/src.js");
    await change("gateways/b/src.js");
    const { choose, asked } = chooser({ select: [gateway("b")] });

    const planned = await prepare(workspace, choose, noHistory);

    expect(asked.pending).toEqual([gateway("a"), gateway("b")]);
    expect(asked.locked.size).toBe(0);
    expect(planned.map((p) => p.name)).toEqual([gateway("b")]);
    expect(await released()).toMatchObject({ [gateway("a")]: "0.1.0" });
  });

  it("raises a declared package's version by the titles of its changes, and offers it", async () => {
    await firstRelease();
    await change("client/src.js");
    const { choose, asked } = chooser({});

    const planned = await prepare(workspace, choose, (_root, pkg) =>
      Promise.resolve(
        pkg.built.name === CLIENT
          ? ["FLEX-1 fix: Mend", "FLEX-2 feat(client): Add"]
          : [],
      ),
    );

    expect(asked.next).toEqual({ [CLIENT]: "0.2.0" });
    expect(planned[0]).toMatchObject({ name: CLIENT, to: "0.2.0" });
    expect(await readJson(workspace.root, "client/package.json")).toMatchObject(
      {
        version: "0.2.0",
      },
    );
  });

  it("locks in everything that depends on a package released", async () => {
    await firstRelease();
    await change("client/src.js");
    const { choose, asked } = chooser({ select: [CLIENT] });

    const planned = await prepare(workspace, choose, noHistory);

    expect(asked.locked).toEqual(
      new Map([
        [gateway("a"), `depends on ${CLIENT}`],
        [gateway("b"), `depends on ${CLIENT}`],
        [SDK, `depends on ${CLIENT}`],
      ]),
    );
    // Each names the client's new version, which the build after it was set wrote.
    expect(planned).toEqual([
      { name: CLIENT, from: "0.1.0", to: "0.1.1", reason: "contents changed" },
      {
        name: gateway("a"),
        from: "0.1.0",
        to: "0.1.1",
        reason: `depends on ${CLIENT}`,
      },
      {
        name: gateway("b"),
        from: "0.1.0",
        to: "0.1.1",
        reason: `depends on ${CLIENT}`,
      },
      { name: SDK, from: "0.1.0", to: "0.1.1", reason: `depends on ${CLIENT}` },
    ]);
  });

  it("locks in the unreleased changes a package released was built with, and what depends on them", async () => {
    await firstRelease();
    await change("client/src.js");
    await change("gateways/a/src.js");
    const { choose, asked } = chooser({ select: [gateway("a")] });

    await prepare(workspace, choose, noHistory);

    expect(asked.locked).toEqual(
      new Map([
        [CLIENT, `${gateway("a")} depends on it`],
        [gateway("b"), `depends on ${CLIENT}`],
        [SDK, `depends on ${CLIENT}`],
      ]),
    );
  });

  it("takes a major a person set by hand, which the gateways follow", async () => {
    await firstRelease();
    await change(
      "client/package.json",
      '{ "name": "@govuk-once/client", "version": "1.0.0" }\n',
    );

    const planned = await prepare(workspace, releaseAll, noHistory);

    expect(planned.map((p) => `${p.name}@${p.to} (${p.reason})`)).toEqual([
      `${CLIENT}@1.0.0 (version set to 1.0.0)`,
      `${gateway("a")}@1.1.0 (new major)`,
      `${gateway("b")}@1.1.0 (new major)`,
      `${SDK}@0.1.1 (contents changed)`,
    ]);
  });

  it("refuses a declared version behind its last release", async () => {
    await firstRelease();
    await change(
      "client/package.json",
      '{ "name": "@govuk-once/client", "version": "0.0.9" }\n',
    );

    await expect(prepare(workspace, releaseAll, noHistory)).rejects.toThrow(
      "client/package.json holds 0.0.9, behind 0.1.0, its last release.",
    );
  });

  it("writes nothing when nothing is chosen", async () => {
    await firstRelease();
    const record = await readText(RECORD_FILE);
    await change("client/src.js");
    const { choose } = chooser({ select: [] });

    expect(await prepare(workspace, choose, noHistory)).toEqual([]);
    expect(await readText(RECORD_FILE)).toBe(record);
  });

  it("puts a manifest's version back when the release goes no further", async () => {
    await firstRelease();
    await change("client/src.js");
    // The build after the client's version is set fails.
    let builds = 0;
    const failing: Workspace = {
      ...workspace,
      build: async (root, sources) => {
        if (++builds === 2) throw new Error("build failed");
        await workspace.build!(root, sources);
      },
    };

    await expect(prepare(failing, releaseAll, noHistory)).rejects.toThrow(
      "build failed",
    );
    expect(await readJson(workspace.root, "client/package.json")).toMatchObject(
      {
        version: "0.1.0",
      },
    );
  });
});

// A registry held in memory, which a publish adds to.
function memoryRegistry(out: string) {
  const held = new Map<string, string[]>();
  const sent: string[] = [];
  const registry: Registry = {
    versions: (name) => Promise.resolve(held.get(name) ?? []),
    publish: (file, tag) => {
      const { name, version } = specOf(path.basename(file));
      held.set(name, [...(held.get(name) ?? []), version]);
      sent.push(`${path.relative(out, file)} ${tag}`);
      return Promise.resolve();
    },
  };
  return { registry, sent };
}

// The package and version a tarball's name gives, as the fixture's packages are named.
function specOf(file: string): { name: string; version: string } {
  const match = /^govuk-once-(.+?)-(\d+\.\d+\.\d+(?:-rc\.\d+)?)\.tgz$/.exec(
    file,
  );
  if (match === null) throw new Error(`${file} is not a tarball's name.`);
  return { name: `@govuk-once/${match[1]!}`, version: match[2]! };
}

describe("packRelease", () => {
  const out = () => path.join(workspace.root, "release-out");
  const options = () => ({ out: out(), candidate: 7 });
  const execFile = promisify(execFileCb);
  const manifestIn = async (file: string) =>
    JSON.parse(
      (
        await execFile("tar", [
          "-xzOf",
          path.join(out(), file),
          "package/package.json",
        ])
      ).stdout,
    ) as Record<string, unknown>;
  const specs = (
    packed: readonly { name: string; version: string; tag?: string }[],
  ) => packed.map((p) => `${p.name}@${p.version}${p.tag ? ` ${p.tag}` : ""}`);
  const nothing = { merge: [], production: [], withheld: [] };

  it("packs nothing before anything is released", async () => {
    const { registry } = memoryRegistry(out());
    await change("gateways/a/src.js");

    expect(await packRelease(workspace, options(), registry)).toEqual(nothing);
  });

  it("packs a release: finals published at merge, and each gateway's candidate then, and its final at production", async () => {
    await firstRelease();
    const { registry } = memoryRegistry(out());

    const plan = await packRelease(workspace, options(), registry);

    expect(specs(plan.merge)).toEqual([
      `${CLIENT}@0.1.0 latest`,
      `${gateway("a")}@0.1.0-rc.7 rc`,
      `${gateway("b")}@0.1.0-rc.7 rc`,
      `${SDK}@0.1.0 latest`,
    ]);
    expect(specs(plan.production)).toEqual([
      `${gateway("a")}@0.1.0 latest`,
      `${gateway("b")}@0.1.0 latest`,
    ]);
    expect(plan.withheld).toEqual([]);
    expect(await readJson(out(), PLAN_FILE)).toEqual(plan);

    // A gateway's candidate names the client's final, published before it.
    expect(await manifestIn(plan.merge[1]!.file)).toMatchObject({
      version: "0.1.0-rc.7",
      peerDependencies: { [CLIENT]: ">=0.1.0 <1.0.0" },
    });
    expect(await manifestIn(plan.merge[3]!.file)).toMatchObject({
      dependencies: { [CLIENT]: "^0.1.0" },
    });
    expect(await manifestIn(plan.production[0]!.file)).toMatchObject({
      version: "0.1.0",
      peerDependencies: { [CLIENT]: ">=0.1.0 <1.0.0" },
      repository: {
        type: "git",
        url: "https://example.com/fixture.git",
        directory: "gateways/a",
      },
    });
  });

  it("packs only what the registry is missing, so a later run makes up for one that did not finish", async () => {
    await firstRelease();
    const { registry } = memoryRegistry(out());
    await packRelease(workspace, options(), registry);
    await publishRelease(out(), "merge", registry);

    const plan = await packRelease(workspace, options(), registry);
    expect(plan.merge).toEqual([]);
    expect(specs(plan.production)).toEqual([
      `${gateway("a")}@0.1.0 latest`,
      `${gateway("b")}@0.1.0 latest`,
    ]);

    await publishRelease(out(), "production", registry);
    expect(await packRelease(workspace, options(), registry)).toEqual(nothing);
  });

  it("packs nothing for changes no release records", async () => {
    await firstRelease();
    const { registry } = memoryRegistry(out());
    await packRelease(workspace, options(), registry);
    await publishRelease(out(), "merge", registry);
    await publishRelease(out(), "production", registry);
    await change("gateways/a/src.js");
    await change("client/src.js");

    expect(await packRelease(workspace, options(), registry)).toMatchObject({
      merge: [],
      production: [],
    });
  });

  it("passes over a release main has changed since, and holds back what names it", async () => {
    await firstRelease();
    await change("client/src.js");
    const { registry } = memoryRegistry(out());

    const plan = await packRelease(workspace, options(), registry);

    expect(plan.merge).toEqual([]);
    expect(plan.production).toEqual([]);
    expect(plan.withheld).toEqual([
      {
        name: CLIENT,
        version: "0.1.0",
        reason:
          "main has changed it since its release, so a later release replaces it",
      },
      ...[gateway("a"), gateway("b"), SDK].map((name) => ({
        name,
        version: "0.1.0",
        reason: `its build names ${CLIENT} 0.1.0, which is not published`,
      })),
    ]);
  });

  it("refuses a record that releases a package nothing builds", async () => {
    await firstRelease();
    await rm(path.join(workspace.root, "gateways/b/package.json"));
    const { registry } = memoryRegistry(out());

    await expect(packRelease(workspace, options(), registry)).rejects.toThrow(
      `${RECORD_FILE} releases ${gateway("b")}, which nothing here builds.`,
    );
  });
});

describe("publishRelease", () => {
  it("publishes a stage in order, each under its tag, passing over what is published", async () => {
    await firstRelease();
    const out = path.join(workspace.root, "release-out");
    const { registry, sent } = memoryRegistry(out);
    await packRelease(workspace, { out, candidate: 1 }, registry);
    await registry.publish(
      path.join(out, "merge", "govuk-once-gateway-a-0.1.0-rc.1.tgz"),
      "rc",
    );
    sent.length = 0;

    expect(await publishRelease(out, "merge", registry)).toEqual({
      published: [
        `${CLIENT}@0.1.0`,
        `${gateway("b")}@0.1.0-rc.1`,
        `${SDK}@0.1.0`,
      ],
      skipped: [`${gateway("a")}@0.1.0-rc.1`],
    });
    await publishRelease(out, "production", registry);

    expect(sent).toEqual([
      "merge/govuk-once-client-0.1.0.tgz latest",
      "merge/govuk-once-gateway-b-0.1.0-rc.1.tgz rc",
      "merge/govuk-once-sdk-0.1.0.tgz latest",
      "production/govuk-once-gateway-a-0.1.0.tgz latest",
      "production/govuk-once-gateway-b-0.1.0.tgz latest",
    ]);
  });

  it("refuses a plan that lists no such stage", async () => {
    const out = path.join(workspace.root, "release-out");
    await setFile(out, PLAN_FILE, "{}\n");
    const { registry } = memoryRegistry(out);

    await expect(publishRelease(out, "merge", registry)).rejects.toThrow(
      `${PLAN_FILE} lists no merge.`,
    );
  });
});

describe("verifyRelease", () => {
  it("names what a release records, when each builds as recorded", async () => {
    await firstRelease();

    expect(await verifyRelease(workspace, new Map())).toEqual([
      CLIENT,
      gateway("a"),
      gateway("b"),
      SDK,
    ]);
  });

  it("releases nothing when the record is unchanged", async () => {
    await firstRelease();
    const before = await readRecord(workspace.root);
    await change("gateways/a/src.js");

    expect(await verifyRelease(workspace, before)).toEqual([]);
  });

  it("refuses a release that does not build as it records", async () => {
    await firstRelease();
    await change("gateways/a/src.js");
    await change("gateways/b/schema", "2\n");

    await expect(verifyRelease(workspace, new Map())).rejects.toThrow(
      [
        `${gateway("a")} does not build as ${RECORD_FILE} releases it, at 0.1.0. Prepare the release again.`,
        `${gateway("b")} does not build as ${RECORD_FILE} releases it, at 0.1.0. Prepare the release again.`,
      ].join("\n"),
    );
  });

  it("refuses a release of a package nothing builds", async () => {
    await firstRelease();
    await rm(path.join(workspace.root, "gateways/b/package.json"));

    await expect(verifyRelease(workspace, new Map())).rejects.toThrow(
      `${RECORD_FILE} releases ${gateway("b")}, which nothing here builds.`,
    );
  });
});
