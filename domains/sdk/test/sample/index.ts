// What the domain's function registers: every route, once. The function and its router are the
// routing ticket's; until then a test drives each route's `run` directly.

import { createTodo } from "./routes/create-todo.ts";
import { deleteTodo } from "./routes/delete-todo.ts";
import { getTodo } from "./routes/get-todo.ts";
import { listTodos } from "./routes/list-todos.ts";

export const routes = [listTodos, getTodo, createTodo, deleteTodo] as const;
