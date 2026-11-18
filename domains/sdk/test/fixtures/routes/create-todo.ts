import type { Handler } from "@govuk-once/flex-domain-sdk";

export const createTodo: Handler<"POST /v1/todos"> = ({ body }) => ({
  status: 201,
  body: { id: "1", title: body.title, done: false },
});
