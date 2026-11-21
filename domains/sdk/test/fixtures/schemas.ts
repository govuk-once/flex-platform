// What a domain's own repository would hold beside its `src/domain.ts`.

import { z } from "zod";

export const TodoSchema = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
});
export type Todo = z.output<typeof TodoSchema>;

// The body of this domain's failures. A domain chooses its own.
export const TodoErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type TodoError = z.output<typeof TodoErrorSchema>;

export const TodoListSchema = z.object({ items: z.array(TodoSchema) });

export const TodoParamsSchema = z.object({ id: z.string() });

// An input refuses fields it does not name, so its objects are strict.
export const TodoQuerySchema = z.strictObject({
  done: z.stringbool().optional(),
});

export const CreateTodoSchema = TodoSchema.pick({ title: true }).strict();

export const UpdateTodoSchema = TodoSchema.omit({ id: true })
  .partial()
  .strict();
