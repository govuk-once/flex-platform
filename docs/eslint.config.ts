import { base } from "@repo/eslint-config";
import { defineConfig } from "eslint/config";
import astro from "eslint-plugin-astro";
import tseslint from "typescript-eslint";

export default defineConfig(base, astro.configs.recommended, {
  // The parser hands typescript-eslint a component without Astro's JSX types, so the typed rules
  // see each element as an error type. astro check typechecks components instead. Prettier cannot
  // parse a component without a plugin of its own.
  files: ["**/*.astro"],
  extends: [tseslint.configs.disableTypeChecked],
  rules: { "prettier/prettier": "off" },
});
