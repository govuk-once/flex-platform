import { describe, expect, it } from "vitest";

import { describeTransportError } from "./diagnostics.ts";

function withCause(name: string, code: unknown): Error {
  return Object.assign(new Error("fetch failed"), {
    name,
    cause: Object.assign(new Error("connect"), { code }),
  });
}

describe("describeTransportError", () => {
  it("keeps a known name and system code", () => {
    expect(describeTransportError(withCause("TypeError", "ECONNREFUSED"))).toBe(
      "TypeError (ECONNREFUSED)",
    );
  });

  it.each(["ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED"])(
    "keeps the listed code %s",
    (code) => {
      expect(describeTransportError(withCause("TypeError", code))).toBe(
        `TypeError (${code})`,
      );
    },
  );

  // The spelling undici actually uses. The near-miss below was in this list and could never
  // have matched, which is why membership is asserted rather than assumed.
  it("keeps the response size code undici raises", () => {
    expect(
      describeTransportError(
        withCause("TypeError", "UND_ERR_RES_EXCEEDED_MAX_SIZE"),
      ),
    ).toBe("TypeError (UND_ERR_RES_EXCEEDED_MAX_SIZE)");
  });

  it.each([
    "UND_ERR_RES_EXCEEDS_MAX_SIZE",
    "UND_ERR_SYNTHETIC_SECRET",
    "SYNTHETIC_CODE",
    "und_err_connect_timeout",
    "ECONNREFUSED_SYNTHETIC",
  ])("drops the unlisted code %s", (code) => {
    expect(describeTransportError(withCause("TypeError", code))).toBe(
      "TypeError",
    );
  });

  it("drops an unlisted name and code", () => {
    expect(
      describeTransportError(withCause("SYNTHETIC_NAME", "SYNTHETIC_CODE")),
    ).toBe("Error");
  });

  // Whatever the error carries, only the two vouched-for parts can appear.
  it("never lets a name, code or message reach the output", () => {
    const err = Object.assign(new Error("SYNTHETIC_MESSAGE"), {
      name: "SYNTHETIC_NAME",
      cause: Object.assign(new Error("SYNTHETIC_CAUSE_MESSAGE"), {
        code: "UND_ERR_SYNTHETIC_SECRET",
        stack: "SYNTHETIC_STACK",
      }),
    });
    const described = describeTransportError(err);
    expect(described).toBe("Error");
    expect(described).not.toMatch(/SYNTHETIC/);
  });

  it("drops a non-string code", () => {
    expect(describeTransportError(withCause("TypeError", 42))).toBe(
      "TypeError",
    );
  });

  it("describes a non-error value as Error", () => {
    expect(describeTransportError("SYNTHETIC")).toBe("Error");
    expect(describeTransportError(undefined)).toBe("Error");
  });

  it("describes an abort by name", () => {
    expect(
      describeTransportError(new DOMException("aborted", "AbortError")),
    ).toBe("AbortError");
  });
});
