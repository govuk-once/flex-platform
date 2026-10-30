import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { Choice } from "./prepare.ts";
import { chooseRelease, toggled } from "./prompt.ts";
import type { Source } from "./sources.ts";
import { lockedIn, type Publishable } from "./workspace.ts";

describe("toggled", () => {
  const pending = new Set(["a", "b"]);

  it("chooses a package with changes, and clears it again", () => {
    expect(toggled(new Set(), ["a"], pending)).toEqual(new Set(["a"]));
    expect(toggled(new Set(["a"]), ["a"], pending)).toEqual(new Set());
  });

  it("never chooses a package without changes", () => {
    expect(toggled(new Set(), ["c"], pending)).toEqual(new Set());
  });

  it("chooses every package with changes in a group, and clears them once all are chosen", () => {
    expect(toggled(new Set(["a"]), ["a", "b", "c"], pending)).toEqual(
      new Set(["a", "b"]),
    );
    expect(toggled(new Set(["a", "b"]), ["a", "b", "c"], pending)).toEqual(
      new Set(),
    );
  });
});

// The prompt as a person answers it, by keys sent to it.
describe("chooseRelease", () => {
  const source = (group: string): Source => ({
    group,
    directories: [],
    script: "",
    output: "",
    versioning: "declared",
    finalAt: "merge",
  });
  const choice = (
    group: string,
    name: string,
    reason: string | undefined,
    peers: Record<string, string> = {},
  ): Choice => {
    const pkg: Publishable = {
      source: source(group),
      directory: name,
      builtDir: name,
      built: { name, version: "0.1.0", peerDependencies: peers },
    };
    return { pkg, released: undefined, digest: "", reason, next: "0.1.1" };
  };
  // A client with changes, and two gateways that depend on it, one of them with changes too.
  const choices = [
    choice("Client", "client", "contents changed"),
    choice("Gateways", "gateway-a", "contents changed", { client: "0.1.0" }),
    choice("Gateways", "gateway-b", undefined, { client: "0.1.0" }),
  ];
  const pending = new Set(["client", "gateway-a"]);
  const lock = (chosen: ReadonlySet<string>) =>
    lockedIn(
      choices.map((c) => c.pkg),
      chosen,
      pending,
    );

  const KEYS = { down: "\x1b[B", space: " ", enter: "\r" };

  async function answer(
    keys: (keyof typeof KEYS)[],
  ): Promise<ReadonlySet<string>> {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const chosen = chooseRelease(choices, lock, { input, output });
    for (const key of keys) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      input.write(KEYS[key]);
    }
    return chosen;
  }

  // The list is: Client, client, Gateways, gateway-a, gateway-b.
  it("ticks what depends on a package as it is chosen", async () => {
    expect(await answer(["down", "space", "enter"])).toEqual(
      new Set(["client", "gateway-a", "gateway-b"]),
    );
  });

  it("ticks what a package was built with as it is chosen", async () => {
    expect(await answer(["down", "down", "down", "space", "enter"])).toEqual(
      new Set(["gateway-a", "client", "gateway-b"]),
    );
  });

  it("keeps a package ticked while something chosen needs it", async () => {
    // gateway-a, then the client, cleared again: gateway-a still needs it.
    expect(
      await answer(["down", "down", "down", "space", "down", "space", "enter"]),
    ).toEqual(new Set(["gateway-a", "client", "gateway-b"]));
  });

  it("chooses nothing for a package without changes of its own", async () => {
    expect(
      await answer(["down", "down", "down", "down", "space", "enter"]),
    ).toEqual(new Set());
  });

  it("chooses a group's packages with changes by its name", async () => {
    expect(await answer(["down", "down", "space", "enter"])).toEqual(
      new Set(["gateway-a", "client", "gateway-b"]),
    );
  });
});
