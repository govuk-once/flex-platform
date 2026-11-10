// An in-memory store, one list per caller. This is just so the sample is doing something.

import type { Todo } from "./schemas.ts";

const lists = new Map<string, Map<string, Todo>>();
let sequence = 0;

function listOf(owner: string): Map<string, Todo> {
  let list = lists.get(owner);
  if (list === undefined) {
    list = new Map();
    lists.set(owner, list);
  }
  return list;
}

export const store = {
  list(owner: string): Todo[] {
    return [...listOf(owner).values()];
  },
  get(owner: string, id: string): Todo | undefined {
    return listOf(owner).get(id);
  },
  hasTitle(owner: string, title: string): boolean {
    return this.list(owner).some((todo) => todo.title === title);
  },
  create(owner: string, title: string): Todo {
    sequence += 1;
    const todo: Todo = { id: `todo-${sequence}`, title, done: false };
    listOf(owner).set(todo.id, todo);
    return todo;
  },
  remove(owner: string, id: string): boolean {
    return listOf(owner).delete(id);
  },
  clear(): void {
    lists.clear();
    sequence = 0;
  },
};
