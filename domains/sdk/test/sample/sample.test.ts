// The sample domain as a domain's own repository would have it: compiled against the built
// package, with no sight of the SDK's sources, then driven through each route's `run`. It calls
// no gateway: a gateway's client is generated from the gateway's contract, and the client's own
// tests cover it.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RouteRequest } from "@govuk-once/flex-domain-sdk";
import { rolldown } from "rolldown";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import config from "../../rolldown.config.ts";
import { routes } from "./index.ts";
import { store } from "./store.ts";

// Built beside the package rather than in the system temp directory: the declarations import
// the SDK's peers and dependencies, which resolve from here.
const GENERATED_ROOT = path.join(import.meta.dirname, "..", "..", ".gen");
const PACKAGE_NAME = "@govuk-once/flex-domain-sdk";

const TSCONFIG = ts.getParsedCommandLineOfConfigFile(
  path.join(import.meta.dirname, "..", "..", "tsconfig.json"),
  undefined,
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      );
    },
  },
)?.options;

describe("the sample domain against the built package", () => {
  let dist: string;
  let compile: (...files: string[]) => string[];

  beforeAll(async () => {
    await mkdir(GENERATED_ROOT, { recursive: true });
    dist = await mkdtemp(path.join(GENERATED_ROOT, "sample-"));
    const { output, ...input } = config;
    const build = await rolldown(input);
    try {
      await build.write({ ...(output as object), dir: dist });
    } finally {
      await build.close();
    }
    // The package name resolves to the built declarations and nothing else.
    const options: ts.CompilerOptions = {
      ...TSCONFIG,
      types: [],
      paths: { [PACKAGE_NAME]: [path.join(dist, "index.d.ts")] },
    };
    compile = (...files) =>
      ts
        .getPreEmitDiagnostics(ts.createProgram(files, options))
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
  }, 60_000);

  afterAll(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  it("compiles", () => {
    expect(compile(path.join(import.meta.dirname, "index.ts"))).toEqual([]);
  });

  it("refuses a handler that strays from the configuration", async () => {
    const file = path.join(dist, "strays.ts");
    const sample = path
      .relative(dist, path.join(import.meta.dirname, "domain.config.ts"))
      .replaceAll(path.sep, "/");
    await writeFile(
      file,
      [
        `import { route } from "${sample}";`,
        // A path parameter the schema does not declare.
        `route("GET /v1/todos/:id", ({ params }) => ({ status: 200, body: { id: params.id, title: params.title, done: true } }));`,
        // A status the route does not declare.
        `route("DELETE /v1/todos/:id", () => ({ status: 200 }));`,
        // A route the configuration does not declare.
        `route("GET /v1/nothing", () => ({ status: 200 }));`,
        "",
      ].join("\n"),
    );
    const diagnostics = compile(file);
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics[0]).toContain("'title' does not exist");
    expect(diagnostics[1]).toContain(
      "'{ readonly status: 200; }' is not assignable",
    );
    expect(diagnostics[2]).toContain('"GET /v1/nothing"');
  });
});

function token(claims: unknown): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

const CALLER = "user-1";

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    body: null,
    deadline: Date.now() + 10_000,
    requestId: "req-1",
    ...overrides,
    headers: {
      "x-flex-secure": token({ pairwiseId: CALLER }),
      "x-correlation-id": "corr-1",
      ...overrides.headers,
    },
  };
}

type Key = (typeof routes)[number]["key"];

function run(key: Key, overrides: Partial<RouteRequest> = {}) {
  const route = routes.find((candidate) => candidate.key === key);
  if (route === undefined) throw new Error(`no route ${key}`);
  return route.run(request(overrides));
}

const json = (body: unknown) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const body = (response: { body: string }) =>
  JSON.parse(response.body) as unknown;

describe("the sample domain's routes", () => {
  afterEach(() => {
    store.clear();
  });

  it("answers 401 to a request without a caller token", async () => {
    const response = await run("GET /v1/todos", {
      headers: { "x-flex-secure": "" },
    });
    expect(response.status).toBe(401);
    expect(body(response)).toEqual({
      message: "Unauthorized",
      type: "auth_error",
      code: "unauthorized",
    });
  });

  it("creates, lists, reads and deletes a todo for the caller", async () => {
    const created = await run("POST /v1/todos", json({ title: "Buy milk" }));
    expect(created.status).toBe(201);
    expect(created.headers).toEqual({
      "content-type": "application/json",
      "x-correlation-id": "corr-1",
    });
    expect(body(created)).toEqual({
      id: "todo-1",
      title: "Buy milk",
      done: false,
    });

    const listed = await run("GET /v1/todos");
    expect(body(listed)).toEqual({
      items: [{ id: "todo-1", title: "Buy milk", done: false }],
      page: 1,
    });

    // Another caller has a list of their own.
    const other = await run("GET /v1/todos", {
      headers: { "x-flex-secure": token({ pairwiseId: "user-2" }) },
    });
    expect(body(other)).toEqual({ items: [], page: 1 });

    const read = await run("GET /v1/todos/:id", { params: { id: "todo-1" } });
    expect(read.status).toBe(200);

    const deleted = await run("DELETE /v1/todos/:id", {
      params: { id: "todo-1" },
    });
    expect(deleted).toEqual({
      status: 204,
      headers: { "x-correlation-id": "corr-1" },
      body: "",
    });

    const gone = await run("GET /v1/todos/:id", { params: { id: "todo-1" } });
    expect(gone.status).toBe(404);
    expect(body(gone)).toEqual({
      message: "Not found",
      type: "client_error",
      code: "not_found",
    });
  });

  it("refuses a body the schema does not accept before the handler runs", async () => {
    const response = await run("POST /v1/todos", json({ title: "" }));
    expect(response.status).toBe(400);
    expect(store.list(CALLER)).toEqual([]);
  });

  it("refuses a body that is not sent as JSON", async () => {
    const response = await run("POST /v1/todos", {
      headers: { "content-type": "text/plain" },
      body: "Buy milk",
    });
    expect(response.status).toBe(415);
  });

  it("answers a failure the route declares by its name", async () => {
    await run("POST /v1/todos", json({ title: "Buy milk" }));
    const again = await run("POST /v1/todos", json({ title: "Buy milk" }));
    expect(again.status).toBe(409);
    expect(body(again)).toMatchObject({ code: "conflict" });
  });

  it("gives the handler the query as the schema's output", async () => {
    const page = await run("GET /v1/todos", { query: { page: "2" } });
    expect(body(page)).toEqual({ items: [], page: 2 });
    const invalid = await run("GET /v1/todos", { query: { page: "two" } });
    expect(invalid.status).toBe(400);
  });
});
