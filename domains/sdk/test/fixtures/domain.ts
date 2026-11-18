import { defineDomain } from "@govuk-once/flex-domain-sdk";

import { createTodo, deleteTodo, getTodo, listTodos } from "./routes/index.ts";
import {
  CreateTodoSchema,
  TodoListSchema,
  TodoParamsSchema,
  TodoQuerySchema,
  TodoSchema,
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
