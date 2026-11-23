// Stands in for what a domain would read through a gateway, so the example runs on its own.

import type { Todo } from "./schemas.ts";

const TODOS: readonly Todo[] = [
  { id: "1", title: "Renew a passport", done: false },
  { id: "2", title: "Tax a vehicle", done: true },
];

export function findTodo(id: string): Todo | undefined {
  return TODOS.find((todo) => todo.id === id);
}
