import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keptFresh } from "./kept-fresh.ts";

const MAX_AGE_MS = 600_000;

// Fails for the addresses in `failing`, and records every load it was asked for.
function loader(failing = new Set<string>()) {
  const loaded: string[] = [];
  return {
    loaded,
    failing,
    load: (address: string) => {
      loaded.push(address);
      return failing.has(address)
        ? Promise.reject(new Error(`unreachable: ${address}`))
        : Promise.resolve();
    },
  };
}

describe("keptFresh", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads an address the first time it is asked", async () => {
    const { load, loaded } = loader();
    const fresh = keptFresh(load, MAX_AGE_MS);

    await fresh("https://a.example");

    expect(loaded).toEqual(["https://a.example"]);
  });

  it("doesn't load again until the last load is the maximum age old, then does", async () => {
    const { load, loaded } = loader();
    const fresh = keptFresh(load, MAX_AGE_MS);
    await fresh("https://a.example");

    vi.advanceTimersByTime(MAX_AGE_MS - 1);
    await fresh("https://a.example");
    expect(loaded).toHaveLength(1);

    vi.advanceTimersByTime(1);
    await fresh("https://a.example");
    await fresh("https://a.example");
    expect(loaded).toHaveLength(2);
  });

  it("counts the age from when the load finished", async () => {
    const loaded: string[] = [];
    const fresh = keptFresh(async (address) => {
      loaded.push(address);
      await vi.advanceTimersByTimeAsync(1_000);
    }, MAX_AGE_MS);
    await fresh("https://a.example");

    vi.advanceTimersByTime(MAX_AGE_MS - 1);
    await fresh("https://a.example");

    expect(loaded).toHaveLength(1);
  });

  it("fails as a load failed, and loads again the next time", async () => {
    const { load, loaded, failing } = loader(new Set(["https://a.example"]));
    const fresh = keptFresh(load, MAX_AGE_MS);

    await expect(fresh("https://a.example")).rejects.toThrow(
      "unreachable: https://a.example",
    );
    await expect(fresh("https://a.example")).rejects.toThrow("unreachable");
    failing.clear();
    await expect(fresh("https://a.example")).resolves.toBeUndefined();

    expect(loaded).toHaveLength(3);
  });

  it("fails once what it loaded is too old and can't be loaded again", async () => {
    const { load, failing } = loader();
    const fresh = keptFresh(load, MAX_AGE_MS);
    await fresh("https://a.example");

    failing.add("https://a.example");
    vi.advanceTimersByTime(MAX_AGE_MS);

    await expect(fresh("https://a.example")).rejects.toThrow("unreachable");
  });

  it("keeps each address's age on its own", async () => {
    const { load, loaded } = loader();
    const fresh = keptFresh(load, MAX_AGE_MS);
    await fresh("https://a.example");

    vi.advanceTimersByTime(MAX_AGE_MS - 1);
    await fresh("https://b.example");
    vi.advanceTimersByTime(1);
    await fresh("https://a.example");
    await fresh("https://b.example");

    expect(loaded).toEqual([
      "https://a.example",
      "https://b.example",
      "https://a.example",
    ]);
  });
});
