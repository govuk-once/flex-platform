import { route } from "../domain.config.ts";
import { store } from "../store.ts";

export const deleteTodo = route(
  "DELETE /v1/todos/:id",
  ({ caller, params, fail }) => {
    if (!store.remove(caller.pairwiseId, params.id)) return fail("not_found");

    return { status: 204 };
  },
);
