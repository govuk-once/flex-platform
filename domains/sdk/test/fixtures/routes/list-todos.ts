import type { Handler } from "@govuk-once/flex-domain-sdk";

export const listTodos: Handler<"GET /v1/todos"> = () => ({
  status: 200,
  body: { items: [] },
});
