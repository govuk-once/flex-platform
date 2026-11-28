import { afterEach, describe, expect, it } from "vitest";

import { credentialsFromEnvironment } from "./credentials.ts";

// Stand-ins, in the shape of a role's credentials.
const CREDENTIALS = {
  accessKeyId: "SYNTHETIC_ACCESS_KEY_ID",
  secretAccessKey: "SYNTHETIC_SECRET_ACCESS_KEY",
  sessionToken: "SYNTHETIC_SESSION_TOKEN/+=",
};

describe("credentialsFromEnvironment", () => {
  const NAMES = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
  ] as const;
  const before = NAMES.map((name) => process.env[name]);

  afterEach(() => {
    NAMES.forEach((name, index) => {
      const value = before[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  });

  it("reads the role's credentials from the variables Lambda sets", () => {
    process.env.AWS_ACCESS_KEY_ID = CREDENTIALS.accessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = CREDENTIALS.secretAccessKey;
    process.env.AWS_SESSION_TOKEN = CREDENTIALS.sessionToken;

    expect(credentialsFromEnvironment()).toEqual(CREDENTIALS);
  });

  it.each(NAMES)("throws without %s, so the request fails closed", (name) => {
    process.env.AWS_ACCESS_KEY_ID = CREDENTIALS.accessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = CREDENTIALS.secretAccessKey;
    process.env.AWS_SESSION_TOKEN = CREDENTIALS.sessionToken;
    delete process.env[name];

    expect(() => credentialsFromEnvironment()).toThrow("credentials");
  });
});
