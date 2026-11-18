import type { Handler } from "@govuk-once/flex-domain-sdk";

export const getTodo: Handler<"GET /v1/todos/{id}"> = ({ params }) => ({
  status: 200,
  body: { id: params.id, title: "A todo", done: false },
});
