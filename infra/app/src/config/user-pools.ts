import type { TrustedIssuer } from "@repo/frontdoor-shared";

// Every Cognito user pool config names, with the app clients trusted in it. A Frontdoor lists the
// app's pools in its issuers. A test user pool is in a stage's shared account, and a Frontdoor
// trusts it only through trustsTestUsers.

export const STAGING: TrustedIssuer = {
  issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_2d00uk68K",
  clientIds: ["7r88bunbmdsvihr2cdb43lasun"],
};

export const PRODUCTION: TrustedIssuer = {
  issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_vn7u4bWbc",
  clientIds: ["40grlhknon5palderi2j1a1bte"],
};

export const PLATFORM_DEV_TEST_USERS: TrustedIssuer = {
  issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_UCFRiLfsD",
  clientIds: ["4hurkb79cvepuo6v078ui1rdhv"],
};
