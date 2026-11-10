import { sectionInfra } from "@repo/eslint-config";

export default [
  ...sectionInfra("gateway"),
  // A stand-in for the bundle codegen writes, which is never linted either.
  { ignores: ["test/bundle/"] },
];
