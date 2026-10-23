import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { Choice } from "./prepare.ts";
import { chooseBump, chooseRelease, tickOf, toggled } from "./prompt.ts";
import type { Source } from "./sources.ts";
import { lockedIn, type Publishable } from "./workspace.ts";

describe("toggled", () => {
  const pending = new Set(["a", "b"]);
  const none = new Map<string, string>();
  // b ticked only because a chosen package needs it.
  const needed = new Map([["b", "depends on a"]]);

  it("chooses a package with changes, and clears it again", () => {
    expect(toggled(new Set(), ["a"], pending, none)).toEqual(new Set(["a"]));
    expect(toggled(new Set(["a"]), ["a"], pending, none)).toEqual(new Set());
  });

  it("never chooses a package without changes", () => {
    expect(toggled(new Set(), ["c"], pending, none)).toEqual(new Set());
  });

  it("chooses every package with changes in a group, and clears them once all are chosen", () => {
    expect(toggled(new Set(["a"]), ["a", "b", "c"], pending, none)).toEqual(
      new Set(["a", "b"]),
    );
    expect(
      toggled(new Set(["a", "b"]), ["a", "b", "c"], pending, none),
    ).toEqual(new Set());
  });

  it("leaves a package something chosen needs as it is, rather than choosing it", () => {
    expect(toggled(new Set(["a"]), ["b"], pending, needed)).toEqual(
      new Set(["a"]),
    );
  });

  it("counts a needed package as ticked in a group, and clears only what was chosen", () => {
    expect(toggled(new Set(["a"]), ["a", "b"], pending, needed)).toEqual(
      new Set(),
    );
    expect(toggled(new Set(), ["a", "b"], pending, needed)).toEqual(
      new Set(["a"]),
    );
  });
});

describe("tickOf", () => {
  const pending = new Set(["a", "b"]);
  const needed = new Map([
    ["b", "depends on a"],
    ["c", "depends on a"],
  ]);
  const chosen = new Set(["a"]);

  it("marks a package chosen, needed or not ticked", () => {
    expect(tickOf(["a"], chosen, needed, pending)).toBe("chosen");
    expect(tickOf(["b"], chosen, needed, pending)).toBe("needed");
    expect(tickOf(["c"], chosen, needed, pending)).toBe("needed");
    expect(tickOf(["d"], chosen, needed, pending)).toBeUndefined();
  });

  it("marks a group chosen once every package in it with changes is", () => {
    expect(tickOf(["a", "c"], chosen, needed, pending)).toBe("chosen");
    expect(tickOf(["a", "b"], chosen, needed, pending)).toBe("needed");
    expect(tickOf(["a", "d"], chosen, needed, pending)).toBeUndefined();
  });
});

// The prompt as a person answers it, by keys sent to it.
const KEYS = { up: "\x1b[A", down: "\x1b[B", space: " ", enter: "\r" };

// Answers a prompt at a stand-in terminal, a key at a time.
async function typed<T>(
  prompt: (terminal: { input: PassThrough; output: PassThrough }) => Promise<T>,
  keys: (keyof typeof KEYS)[],
): Promise<T> {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const answer = prompt({ input, output });
  for (const key of keys) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    input.write(KEYS[key]);
  }
  return answer;
}

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

  const answer = (keys: (keyof typeof KEYS)[]) =>
    typed((terminal) => chooseRelease(choices, lock, terminal), keys);

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
      await answer([
        "down",
        "down",
        "down",
        "space",
        "up",
        "up",
        "space",
        "enter",
      ]),
    ).toEqual(new Set(["gateway-a", "client", "gateway-b"]));
  });

  it("clears what a package brought with it once it is cleared, even after clearing those", async () => {
    // The client, then the gateways it ticked, which stay, then the client again.
    expect(
      await answer(["down", "space", "down", "space", "up", "space", "enter"]),
    ).toEqual(new Set());
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

describe("chooseBump", () => {
  const choice: Choice = {
    pkg: {
      source: {
        group: "Client",
        directories: [],
        script: "",
        output: "",
        versioning: "declared",
        finalAt: "merge",
      },
      directory: "client",
      builtDir: "client",
      built: { name: "client", version: "0.1.0" },
    },
    released: { version: "0.1.0", digest: "" },
    digest: "",
    reason: "contents changed",
    next: undefined,
  };

  it.each([
    [[], "patch"],
    [["down"], "minor"],
    [["down", "down"], "major"],
  ] as const)("after %j, raises by a %s", async (keys, bump) => {
    expect(
      await typed(
        (terminal) => chooseBump(choice, "0.1.0", terminal),
        [...keys, "enter"],
      ),
    ).toBe(bump);
  });
});
