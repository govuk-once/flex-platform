import type { ZoneConfig } from "./types.ts";

// Every account's public hosted zone, each named for the zone. The zones aren't the platform's:
// another team creates one in each account, already delegated, named
// <environment>.flex-<account role>.once.service.gov.uk.

// platform-dev
export const DEVELOPMENT_FLEX_SHARED: ZoneConfig = {
  name: "development.flex-shared.once.service.gov.uk",
  id: "Z1047090331J6R3FXTKE0",
};
export const DEVELOPMENT_FLEX_PLATFORM: ZoneConfig = {
  name: "development.flex-platform.once.service.gov.uk",
  id: "Z0835542Q6J8ILWJ1RGR",
};
export const DEVELOPMENT_FLEX_PLATFORMEDGE: ZoneConfig = {
  name: "development.flex-platformedge.once.service.gov.uk",
  id: "Z031433615ESLO5K1AH7F",
};

// platform-staging
export const STAGING_FLEX_SHARED: ZoneConfig = {
  name: "staging.flex-shared.once.service.gov.uk",
  id: "Z03533672JRTLG1VW6T1S",
};
export const STAGING_FLEX_PLATFORM: ZoneConfig = {
  name: "staging.flex-platform.once.service.gov.uk",
  id: "Z0085548AFKTJHKTHK3P",
};
export const STAGING_FLEX_PLATFORMEDGE: ZoneConfig = {
  name: "staging.flex-platformedge.once.service.gov.uk",
  id: "Z0462383HSDK7C8IQ6HN",
};

// platform-prod
export const PRODUCTION_FLEX_SHARED: ZoneConfig = {
  name: "production.flex-shared.once.service.gov.uk",
  id: "Z01265801EAWB10P5SLMD",
};
export const DEVELOPMENT_FLEX_DOMAIN00: ZoneConfig = {
  name: "development.flex-domain00.once.service.gov.uk",
  id: "Z05812543BRVPCL728ND0",
};
export const DEVELOPMENT_FLEX_DOMAINEDGE: ZoneConfig = {
  name: "development.flex-domainedge.once.service.gov.uk",
  id: "Z08635081XAI47LT6BSJQ",
};
export const STAGING_FLEX_DOMAIN00: ZoneConfig = {
  name: "staging.flex-domain00.once.service.gov.uk",
  id: "Z02914492HOQJQ6UXSZ9B",
};
export const STAGING_FLEX_DOMAINEDGE: ZoneConfig = {
  name: "staging.flex-domainedge.once.service.gov.uk",
  id: "Z0490122CGGKQPL28DUH",
};
export const PRODUCTION_FLEX_DOMAIN00: ZoneConfig = {
  name: "production.flex-domain00.once.service.gov.uk",
  id: "Z0411378AOM55J0BQQZI",
};
export const PRODUCTION_FLEX_DOMAINEDGE: ZoneConfig = {
  name: "production.flex-domainedge.once.service.gov.uk",
  id: "Z04221372NJE375QTYYDR",
};
