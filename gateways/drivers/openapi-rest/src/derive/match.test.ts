import { describe, expect, it } from "vitest";

import { couldReach, fit, isMoreSpecific } from "./match.ts";

const fitted = (path: string, template: string) => {
  const result = fit(path, template);
  return typeof result === "string"
    ? result
    : {
        fixed: Object.fromEntries(result.fixed),
        carried: Object.fromEntries(result.carried),
      };
};

describe("fit", () => {
  it("fills a parameter that takes every remaining segment with the segments a path writes out", () => {
    expect(fitted("/v1/notifications", "/v1/{resourcePath+}")).toEqual({
      fixed: { resourcePath: "notifications" },
      carried: {},
    });
    expect(fitted("/v1/app/settings/theme", "/v1/{resourcePath+}")).toEqual({
      fixed: { resourcePath: "app/settings/theme" },
      carried: {},
    });
  });

  it("fills an ordinary parameter with one segment, and carries one the path leaves a parameter", () => {
    expect(
      fitted(
        "/v1/identity/app/{id}/linked-services",
        "/v1/identity/{serviceName}/{identifier}/linked-services",
      ),
    ).toEqual({ fixed: { serviceName: "app" }, carried: { identifier: "id" } });
  });

  it.each([
    ["/v2/notifications", "/v1/{resourcePath+}", 'its segment 1 is not "v1"'],
    [
      "/v1",
      "/v1/{resourcePath+}",
      "it has no segment for the template's last parameter",
    ],
    ["/v1/a/b", "/v1/{one}", "it has more segments than the template"],
    ["/v1", "/v1/{one}", "it has fewer segments than the template"],
    [
      "/v1/things/{id}",
      "/v1/{resourcePath+}",
      'what "{resourcePath+}" takes has to be written out, and "{id}" is a parameter',
    ],
    [
      "/v1/a/b",
      "/v1/{rest+}/b",
      '"{rest+}" takes every segment that is left, so it can only come last',
    ],
    ["/v1/{x}/b", "/v1/a/b", 'its segment 2 is not "a"'],
    // What a router may read as another path: "/v1/sar/abc" is "/v1/sar/{sarId}"'s to answer.
    [
      "/v1/sar/abc/",
      "/v1/{resourcePath+}",
      "its segment 4 is empty, which a router may drop or merge with the next",
    ],
    [
      "/v1//sar/abc",
      "/v1/{resourcePath+}",
      "its segment 2 is empty, which a router may drop or merge with the next",
    ],
    ...["/v1/sar%2Fabc", "/v1/sar%2fabc", "/v1/sar%5Cabc", "/v1/sar\\abc"].map(
      (path) => [
        path,
        "/v1/{resourcePath+}",
        "its segment 2 writes a slash or a backslash inside it, which a router may read as a separator",
      ],
    ),
  ])("says why %s does not fit %s", (path, template, why) => {
    expect(fitted(path, template)).toBe(why);
  });
});

describe("couldReach", () => {
  const nothingExcluded = () => false;

  it("holds a path's text to the text around a parameter that shares its segment", () => {
    expect(
      couldReach("/v1/notifications", "/v1/{file}.json", nothingExcluded),
    ).toBe(false);
    expect(
      couldReach("/v1/report.json", "/v1/{file}.json", nothingExcluded),
    ).toBe(true);
    // Read as it reads: ".json" written as an escape is the same text.
    expect(
      couldReach("/v1/report%2Ejson", "/v1/{file}.json", nothingExcluded),
    ).toBe(true);
  });

  it("takes a parameter of the path's own to reach such a segment, since its value could", () => {
    expect(couldReach("/v1/{id}", "/v1/{file}.json", nothingExcluded)).toBe(
      true,
    );
  });
});

describe("isMoreSpecific", () => {
  it("puts a segment written out before a parameter, and a parameter before one that takes the rest", () => {
    expect(isMoreSpecific("/v1/sar/{sarId}", "/v1/{resourcePath+}")).toBe(true);
    expect(isMoreSpecific("/v1/{a}/{b}", "/v1/{resourcePath+}")).toBe(true);
    expect(isMoreSpecific("/v1/{resourcePath+}", "/v1/sar/{sarId}")).toBe(
      false,
    );
    expect(isMoreSpecific("/v1/{resourcePath+}", "/v1/{resourcePath+}")).toBe(
      false,
    );
    expect(isMoreSpecific("/v1/sar/{sarId}", "/v1/{a}/{b}")).toBe(true);
  });
});
