import type { Handler } from "@govuk-once/flex-domain-sdk";
import { notFound } from "@govuk-once/flex-domain-sdk";

import { findTodo } from "../todos.ts";

export const getTodo: Handler<"GET /v1/todos/{id}"> = ({ params }) => {
  const todo = findTodo(params.id);

  if (todo === undefined) {
    return notFound({
      error: { code: "todo_not_found", message: "No such todo" },
    });
  }

  return { status: 200, body: todo };
};
