// What a domain's own repository would hold beside its `src/domain.ts`.

import { z } from "zod";

export const TodoSchema = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
});
export type Todo = z.output<typeof TodoSchema>;

export const TodoListSchema = z.object({ items: z.array(TodoSchema) });

export const TodoParamsSchema = z.object({ id: z.string() });

// An input refuses fields it does not name, so its objects are strict.
export const TodoQuerySchema = z.strictObject({
  done: z.stringbool().optional(),
});

export const CreateTodoSchema = TodoSchema.pick({ title: true }).strict();
