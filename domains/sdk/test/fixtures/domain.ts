import { defineDomain } from "@govuk-once/flex-domain-sdk";

import { createTodo } from "./routes/create-todo.ts";
import { deleteTodo } from "./routes/delete-todo.ts";
import { getTodo } from "./routes/get-todo.ts";
import { listTodos } from "./routes/list-todos.ts";
import { updateTodo } from "./routes/update-todo.ts";
import {
  CreateTodoSchema,
  TodoErrorSchema,
  TodoListSchema,
  TodoParamsSchema,
  TodoQuerySchema,
  TodoSchema,
  UpdateTodoSchema,
} from "./schemas.ts";

const domain = defineDomain({
  name: "domain-a",
  description: "Domain for my todos",
  routes: {
    "GET /v1/todos": {
      handler: listTodos,
      operationId: "listTodos",
      description: "List all todos",
      query: TodoQuerySchema,
      responses: { 200: TodoListSchema },
    },
    "GET /v1/todos/{id}": {
      handler: getTodo,
      operationId: "getTodo",
      description: "Retrieve a single todo",
      params: TodoParamsSchema,
      responses: { 200: TodoSchema, 404: TodoErrorSchema },
    },
    "POST /v1/todos": {
      handler: createTodo,
      operationId: "createTodo",
      description: "Create a todo",
      body: CreateTodoSchema,
      responses: { 201: TodoSchema, 409: TodoErrorSchema },
    },
    "PATCH /v1/todos/{id}": {
      handler: updateTodo,
      operationId: "updateTodo",
      description: "Update a todo",
      params: TodoParamsSchema,
      body: UpdateTodoSchema,
      responses: { 204: null, 404: null },
    },
    "DELETE /v1/todos/{id}": {
      handler: deleteTodo,
      operationId: "deleteTodo",
      description: "Delete a todo",
      params: TodoParamsSchema,
      responses: { 204: null, 404: null },
    },
  },
});

export default domain;

declare module "@govuk-once/flex-domain-sdk" {
  interface Register {
    readonly domain: typeof domain;
  }
}
