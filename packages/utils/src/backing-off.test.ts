import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { backingOff } from "./backing-off.ts";

const WAIT_MS = 5_000;

// Fails for the addresses in `failing`, and records every fetch it was asked for.
function fetcher(failing: Set<string>) {
  const fetched: string[] = [];
  return {
    fetched,
    fetch: (uri: string, suffix = "") => {
      fetched.push(uri);
      return failing.has(uri)
        ? Promise.reject(new Error(`unreachable: ${uri}`))
        : Promise.resolve(`document at ${uri}${suffix}`);
    },
  };
}

describe("backingOff", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a fetch through, with every argument, and answers with its result", async () => {
    const inner = fetcher(new Set());
    const { fetch } = backingOff(inner, WAIT_MS);

    await expect(fetch("https://a.example", "!")).resolves.toBe(
      "document at https://a.example!",
    );
    await expect(fetch("https://a.example")).resolves.toBe(
      "document at https://a.example",
    );
    expect(inner.fetched).toEqual(["https://a.example", "https://a.example"]);
  });

  it("passes on the error of a fetch that failed", async () => {
    const { fetch } = backingOff(
      fetcher(new Set(["https://a.example"])),
      WAIT_MS,
    );

    await expect(fetch("https://a.example")).rejects.toThrow(
      "unreachable: https://a.example",
    );
  });

  it("fails without fetching until the wait is over, then fetches again", async () => {
    const failing = new Set(["https://a.example"]);
    const inner = fetcher(failing);
    const { fetch } = backingOff(inner, WAIT_MS);

    await expect(fetch("https://a.example")).rejects.toThrow("unreachable");
    failing.clear();

    vi.advanceTimersByTime(WAIT_MS - 1);
    await expect(fetch("https://a.example")).rejects.toThrow(
      "The address failed to fetch moments ago",
    );
    expect(inner.fetched).toHaveLength(1);

    vi.advanceTimersByTime(1);
    await expect(fetch("https://a.example")).resolves.toBe(
      "document at https://a.example",
    );
    expect(inner.fetched).toHaveLength(2);
  });

  it("waits for each address on its own", async () => {
    const inner = fetcher(new Set(["https://a.example"]));
    const { fetch } = backingOff(inner, WAIT_MS);

    await expect(fetch("https://a.example")).rejects.toThrow();

    await expect(fetch("https://b.example")).resolves.toBe(
      "document at https://b.example",
    );
  });

  it("starts the wait again from a fetch that fails after it", async () => {
    const inner = fetcher(new Set(["https://a.example"]));
    const { fetch } = backingOff(inner, WAIT_MS);

    await expect(fetch("https://a.example")).rejects.toThrow("unreachable");
    vi.advanceTimersByTime(WAIT_MS);
    await expect(fetch("https://a.example")).rejects.toThrow("unreachable");
    vi.advanceTimersByTime(WAIT_MS - 1);
    await expect(fetch("https://a.example")).rejects.toThrow("moments ago");

    expect(inner.fetched).toHaveLength(2);
  });

  it("answers with a document its check passes", async () => {
    const checked: string[] = [];
    const { fetch } = backingOff(fetcher(new Set()), WAIT_MS, (document) => {
      checked.push(document);
    });

    await expect(fetch("https://a.example")).resolves.toBe(
      "document at https://a.example",
    );
    expect(checked).toEqual(["document at https://a.example"]);
  });

  it("fails as its check threw for a document, and waits before fetching it again", async () => {
    const inner = fetcher(new Set());
    let valid = false;
    const { fetch } = backingOff(inner, WAIT_MS, () => {
      if (!valid) throw new Error("not the document");
    });

    await expect(fetch("https://a.example")).rejects.toThrow(
      "not the document",
    );
    valid = true;
    await expect(fetch("https://a.example")).rejects.toThrow("moments ago");
    expect(inner.fetched).toHaveLength(1);

    vi.advanceTimersByTime(WAIT_MS);
    await expect(fetch("https://a.example")).resolves.toBe(
      "document at https://a.example",
    );
    expect(inner.fetched).toHaveLength(2);
  });
});
