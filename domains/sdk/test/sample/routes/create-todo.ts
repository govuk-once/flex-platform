import { route } from "../domain.config.ts";
import { store } from "../store.ts";

export const createTodo = route(
  "POST /v1/todos",
  ({ caller, body, headers, log, fail }) => {
    if (headers.clientVersion !== undefined) {
      log.debug("client version", { clientVersion: headers.clientVersion });
    }

    if (store.hasTitle(caller.pairwiseId, body.title)) return fail("conflict");

    return { status: 201, body: store.create(caller.pairwiseId, body.title) };
  },
);
