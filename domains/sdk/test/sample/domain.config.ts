import { domain } from "@govuk-once/flex-domain-sdk";

import {
  CreateTodo,
  ListQuery,
  Todo,
  TodoList,
  TodoParams,
} from "./schemas.ts";

export const { config, route, routeContext } = domain({
  name: "todos",
  common: {
    headers: {
      clientVersion: { name: "X-Client-Version", required: false },
    },
  },
  routes: {
    v1: {
      "/todos": {
        GET: {
          query: ListQuery,
          responses: { 200: TodoList },
        },
        POST: {
          body: CreateTodo,
          responses: { 201: Todo },
          errors: ["conflict"],
        },
      },
      "/todos/:id": {
        GET: {
          params: TodoParams,
          responses: { 200: Todo },
          errors: ["not_found"],
        },
        DELETE: {
          params: TodoParams,
          responses: { 204: null },
          errors: ["not_found"],
        },
      },
    },
  },
});
