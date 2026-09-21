import type { JSONSchema } from "@repo/gateway-types";

// UDP keeps whatever it is given under whatever path, and describes all of it once: a template
// that takes any path, and data of any shape. An operation on something kept there writes its
// path out in full and names this as its `matches`; what is kept there is Flex's own, so its
// shape is stated beside this, one module for each thing kept.
export const DATA_STORE = "/v1/{resourcePath+}";

// What UDP keeps is wrapped as `{ data }`, going in and coming out.
export const stored = (data: JSONSchema): JSONSchema => ({
  type: "object",
  properties: { data },
  required: ["data"],
});
