import type { Handler } from "@govuk-once/flex-domain-sdk";

export const deleteTodo: Handler<"DELETE /v1/todos/{id}"> = () => ({
  status: 204,
});
