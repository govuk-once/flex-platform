// The sample's contract: what each route takes and answers, as Zod schemas. A response schema's
// output is what is sent, so `Todo` is also the shape a stored todo is held to on the way out.

import { z } from "zod";

export const TodoId = z.string().regex(/^[a-z0-9-]+$/, "a todo id");

export const Todo = z.object({
  id: TodoId,
  title: z.string().min(1).max(200),
  done: z.boolean(),
});
export type Todo = z.infer<typeof Todo>;

export const TodoParams = z.object({ id: TodoId });

export const CreateTodo = Todo.pick({ title: true });

// The query arrives as strings. The schema turns the page into a number before the handler sees
// it, so the handler's `query.page` is typed `number`.
export const ListQuery = z.object({
  page: z.string().regex(/^\d+$/).transform(Number).default(1),
});

export const TodoList = z.object({
  items: z.array(Todo),
  page: z.number().int().positive(),
});
