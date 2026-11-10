import { route } from "../domain.config.ts";
import { store } from "../store.ts";

export const getTodo = route(
  "GET /v1/todos/:id",
  ({ caller, params, fail }) => {
    const todo = store.get(caller.pairwiseId, params.id);
    if (todo === undefined) return fail("not_found");

    return { status: 200, body: todo };
  },
);
