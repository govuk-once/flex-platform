import { describe, expect, it } from "vitest";

import { toRuntimeCode } from "./build.ts";

describe("toRuntimeCode", () => {
  it("removes the export, leaving the handler at the top level", () => {
    expect(
      toRuntimeCode(
        "var a=1;function handler(event){return a}export{handler};\n",
      ),
    ).toBe("var a=1;function handler(event){return a}");
  });

  it("accepts an async handler", () => {
    expect(
      toRuntimeCode(
        "async function handler(event){return event}export{handler};",
      ),
    ).toBe("async function handler(event){return event}");
  });

  // What esbuild emits for `export const handler = (event) => event`.
  it("refuses an arrow-function handler", () => {
    expect(() =>
      toRuntimeCode("const handler=event=>event;export{handler};\n"),
    ).toThrow("The bundle doesn't declare `function handler(`");
  });

  it("refuses a bundle that doesn't export handler", () => {
    expect(() =>
      toRuntimeCode("function handler(event){return event}"),
    ).toThrow("The bundle doesn't end by exporting handler");
  });

  it.each([
    [
      "only inside another function",
      "var x=function(){function handler(e){}};export{handler};",
    ],
    [
      "inside another function after a var",
      "var x=function(){var a=1;function handler(e){}};export{handler};",
    ],
    [
      "as a variable merged into another declaration",
      "const a=1,handler=e=>e;export{handler};",
    ],
    [
      "as a function expression",
      "var handler=function(e){return e};export{handler};",
    ],
    ["as a class", "class handler{};export{handler};"],
  ])("refuses a handler declared %s", (_, output) => {
    expect(() => toRuntimeCode(output)).toThrow(
      "The bundle doesn't declare `function handler(`",
    );
  });
});
