import { describe, expect, it } from "vitest";

import { requestContext } from "../test/fixtures/request-context.ts";

const {
  caller: { pairwiseId, pushId },
  log,
} = requestContext();

// Each call is checked by the compiler. Running them shows only that they do not throw.
describe("Log", () => {
  it("takes fixed text and scalar fields", () => {
    expect(() => {
      log.info("todo not found");
      log.warn("gateway call retried", {
        attempt: 2,
        cached: false,
        region: "eu-west-2",
        etag: null,
      });
    }).not.toThrow();
  });

  it("refuses a message that is not fixed text, or is a caller ID", () => {
    const id = String(Date.now());

    // @ts-expect-error: message must be a string literal, pass values as fields
    log.info(`todo ${id} not found`);
    // @ts-expect-error: message must be a string literal, pass values as fields
    log.warn(id);
    // @ts-expect-error: pairwiseId and pushId are personal data, never log them
    log.info(pairwiseId);
  });

  it("refuses a field that is a caller ID or not a scalar", () => {
    // @ts-expect-error: pairwiseId and pushId are personal data, never log them
    log.info("caller seen", { user: pairwiseId });
    // @ts-expect-error: pairwiseId and pushId are personal data, never log them
    log.warn("caller seen", { push: pushId });
    // @ts-expect-error: fields are scalars
    log.info("todo seen", { todo: { id: "1" } });
  });
});
