import type { Handler } from "@govuk-once/flex-domain-sdk";

export const updateTodo: Handler<"PATCH /v1/todos/{id}"> = () => ({
  status: 204,
});
