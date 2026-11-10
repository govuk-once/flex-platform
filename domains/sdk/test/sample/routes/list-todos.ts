import { route } from "../domain.config.ts";
import { store } from "../store.ts";

const PAGE_SIZE = 20;

export const listTodos = route("GET /v1/todos", ({ caller, query }) => {
  const start = (query.page - 1) * PAGE_SIZE;

  return {
    status: 200,
    body: {
      items: store.list(caller.pairwiseId).slice(start, start + PAGE_SIZE),
      page: query.page,
    },
  };
});
