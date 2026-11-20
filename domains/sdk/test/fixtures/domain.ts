import { defineDomain } from "@govuk-once/flex-domain-sdk";

import { createTodo } from "./routes/create-todo.ts";
import { deleteTodo } from "./routes/delete-todo.ts";
import { getTodo } from "./routes/get-todo.ts";
import { listTodos } from "./routes/list-todos.ts";
import { updateTodo } from "./routes/update-todo.ts";
import {
  CreateTodoSchema,
  TodoListSchema,
  TodoParamsSchema,
  TodoQuerySchema,
  TodoSchema,
  UpdateTodoSchema,
} from "./schemas.ts";

const domain = defineDomain({
  name: "domain-a",
  routes: {
    "GET /v1/todos": {
      handler: listTodos,
      query: TodoQuerySchema,
      responses: { 200: TodoListSchema },
    },
    "GET /v1/todos/{id}": {
      handler: getTodo,
      params: TodoParamsSchema,
      responses: { 200: TodoSchema },
      errors: ["not_found"],
    },
    "POST /v1/todos": {
      handler: createTodo,
      body: CreateTodoSchema,
      responses: { 201: TodoSchema },
      errors: ["conflict"],
    },
    "PATCH /v1/todos/{id}": {
      handler: updateTodo,
      params: TodoParamsSchema,
      body: UpdateTodoSchema,
      responses: { 204: null },
      errors: ["not_found"],
    },
    "DELETE /v1/todos/{id}": {
      handler: deleteTodo,
      params: TodoParamsSchema,
      responses: { 204: null },
      errors: ["not_found"],
    },
  },
});

export default domain;

declare module "@govuk-once/flex-domain-sdk" {
  interface Register {
    readonly domain: typeof domain;
  }
}
