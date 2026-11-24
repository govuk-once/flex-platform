import { describe, expect, it } from "vitest";

import { keptWhile } from "./kept-while.ts";

// A load that settles only when the test says, and records what each was given as held.
function loader() {
  const given: (string | undefined)[] = [];
  const settle: {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  }[] = [];
  return {
    given,
    settle,
    load: (held: string | undefined) => {
      given.push(held);
      return new Promise<string>((resolve, reject) => {
        settle.push({ resolve, reject });
      });
    },
  };
}

describe("keptWhile", () => {
  it("loads the value the first time it is asked, with nothing held", async () => {
    const { load, given, settle } = loader();
    const value = keptWhile(load, () => true);

    const asked = value();
    settle[0]?.resolve("first");

    await expect(asked).resolves.toBe("first");
    expect(given).toEqual([undefined]);
  });

  it("returns what it holds while that is current, without loading", async () => {
    const { load, given, settle } = loader();
    const value = keptWhile(load, () => true);
    const asked = value();
    settle[0]?.resolve("first");
    await asked;

    await expect(value()).resolves.toBe("first");
    await expect(value()).resolves.toBe("first");
    expect(given).toHaveLength(1);
  });

  it("asks whether what it holds is current each time, and loads again once it isn't, given what it holds", async () => {
    const { load, given, settle } = loader();
    const asked: string[] = [];
    let current = true;
    const value = keptWhile(load, (held) => {
      asked.push(held);
      return current;
    });
    const first = value();
    settle[0]?.resolve("first");
    await first;
    await value();

    current = false;
    const second = value();
    settle[1]?.resolve("second");

    await expect(second).resolves.toBe("second");
    expect(given).toEqual([undefined, "first"]);
    expect(asked).toEqual(["first", "first"]);

    current = true;
    await expect(value()).resolves.toBe("second");
    expect(given).toHaveLength(2);
  });

  it("runs the load once for callers that ask while it is under way, and gives each its result", async () => {
    const { load, given, settle } = loader();
    const value = keptWhile(load, () => true);

    const callers = [value(), value(), value()];
    expect(given).toHaveLength(1);
    settle[0]?.resolve("loaded");

    await expect(Promise.all(callers)).resolves.toEqual([
      "loaded",
      "loaded",
      "loaded",
    ]);
  });

  it("fails every caller that was waiting on a load that failed, and loads again for the next", async () => {
    const { load, given, settle } = loader();
    const value = keptWhile(load, () => true);

    const waiting = [value(), value()];
    settle[0]?.reject(new Error("unreachable"));
    for (const caller of waiting) {
      await expect(caller).rejects.toThrow("unreachable");
    }

    const next = value();
    expect(given).toEqual([undefined, undefined]);
    settle[1]?.resolve("loaded");
    await expect(next).resolves.toBe("loaded");
  });

  it("leaves what it holds as it was when a later load fails", async () => {
    const { load, given, settle } = loader();
    let current = true;
    const value = keptWhile(load, () => current);
    const first = value();
    settle[0]?.resolve("first");
    await first;

    current = false;
    const failed = value();
    settle[1]?.reject(new Error("unreachable"));
    await expect(failed).rejects.toThrow("unreachable");

    current = true;
    await expect(value()).resolves.toBe("first");
    expect(given).toEqual([undefined, "first"]);
  });

  it("holds a value that is undefined", async () => {
    let loads = 0;
    const value = keptWhile(
      () => {
        loads += 1;
        return Promise.resolve(undefined);
      },
      () => true,
    );

    await value();
    await value();
    expect(loads).toBe(1);
  });
});
