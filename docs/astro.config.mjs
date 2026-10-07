import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

const REPOSITORY = "https://github.com/govuk-once/flex-platform";

// Published to GitHub Pages as a project site, so every page is served under the repository's
// name. Links written in content include the base; the links validator fails the build on one
// that points nowhere.
export default defineConfig({
  site: "https://govuk-once.github.io",
  base: "/flex-platform",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "Flex Platform",
      description:
        "Flex is the platform behind the GOV.UK app. It connects what GOV.UK knows about a user with the government services the app is built to work with.",
      social: [{ icon: "github", label: "GitHub", href: REPOSITORY }],
      editLink: { baseUrl: `${REPOSITORY}/edit/main/docs/` },
      lastUpdated: true,
      plugins: [starlightLinksValidator()],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Introduction", slug: "" },
            "start/platform",
            "start/working-in-the-repo",
            "start/conventions",
          ],
        },
        // Grouped by the platform's sections. Only egress is built in this repository; the
        // Frontdoor and domains are planned, and their pages say so.
        {
          label: "Frontdoor",
          items: ["frontdoor/overview"],
        },
        {
          label: "Domains",
          items: ["domains/overview", "domains/designing-a-domain"],
        },
        {
          label: "Egress",
          items: [
            {
              label: "Gateways",
              items: [
                "gateways/overview",
                "gateways/configuration",
                "gateways/schemas",
                "gateways/compatibility",
                "gateways/responses",
                "gateways/creating-a-gateway",
              ],
            },
            {
              label: "Code generation",
              items: [
                "codegen/overview",
                "codegen/checks",
                "codegen/entry-point",
                "codegen/call-contract",
              ],
            },
            {
              label: "Drivers",
              items: [
                "drivers/contract",
                "drivers/writing-a-driver",
                {
                  label: "openapi-rest",
                  collapsed: true,
                  items: [
                    "drivers/openapi-rest/overview",
                    "drivers/openapi-rest/outcomes",
                    "drivers/openapi-rest/executor",
                    "drivers/openapi-rest/authentication",
                    "drivers/openapi-rest/metadata",
                    "drivers/openapi-rest/deriving-schemas",
                    "drivers/openapi-rest/handlers",
                  ],
                },
              ],
            },
          ],
        },
        {
          label: "Infrastructure",
          items: ["infrastructure/overview"],
        },
        {
          label: "Reference",
          items: [
            "reference/packages",
            "reference/environment",
            "reference/design-constraints",
            "reference/glossary",
          ],
        },
      ],
    }),
  ],
});
