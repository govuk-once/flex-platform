// The workspace's packages and what each depends on, read from their manifests as the site builds,
// and laid out by dagre in layers: each package sits above everything it depends on. A dependency
// already reached through another is not drawn, so the diagram shows the structure rather than
// every line a manifest holds.

import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";

import { graphlib, layout } from "@dagrejs/dagre";
import { sortedNames } from "@repo/utils/sorted-names";

// Every package uses these, so drawing them would only add an arrow to each. The site is not a
// library.
const LEFT_OUT = new Set([
  "@repo/docs",
  "@repo/eslint-config",
  "@repo/tsconfig",
  "@repo/vitest-config",
]);

// Every gateway and every driver has the same shape, and there will be many of them, so each kind
// is drawn as one box standing for all its packages, with all their dependencies.
const GROUPS = [
  {
    directory: "gateways/services/",
    name: "@repo/gateway-service-<id>",
    label: "gateways/services/<id>",
  },
  {
    directory: "gateways/drivers/",
    name: "@repo/gateway-driver-<name>",
    label: "gateways/drivers/<name>",
  },
];

export const BOX_WIDTH = 252;
export const BOX_HEIGHT = 46;

interface Manifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

interface WorkspacePackage {
  readonly directory: string;
  /** The other workspace packages it depends on. */
  runtime: string[];
  dev: string[];
}

interface Point {
  readonly x: number;
  readonly y: number;
}

// pnpm runs the site's scripts in docs/, so the workspace is the nearest directory above that
// holds pnpm-workspace.yaml.
function workspaceRoot(): string {
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    if (dir === path.dirname(dir)) {
      throw new Error("No pnpm-workspace.yaml above the site's directory");
    }
  }
}

// The workspace file lists each package directory as `  - <glob>` under `packages:`.
function packageGlobs(root: string): string[] {
  const lines = readFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    "utf-8",
  ).split("\n");
  const globs: string[] = [];
  for (const line of lines.slice(lines.indexOf("packages:") + 1)) {
    const match = /^\s+-\s+"?([^"]+?)"?\s*$/.exec(line);
    if (match === null) break;
    globs.push(match[1]!);
  }
  if (globs.length === 0)
    throw new Error("pnpm-workspace.yaml lists no packages");
  return globs;
}

function readWorkspace(): Map<string, WorkspacePackage> {
  const root = workspaceRoot();
  const found = packageGlobs(root)
    .flatMap((glob) => globSync(`${glob}/package.json`, { cwd: root }))
    .map((file) => ({
      directory: path.dirname(file),
      manifest: JSON.parse(
        readFileSync(path.join(root, file), "utf-8"),
      ) as Manifest,
    }))
    .filter(({ manifest }) => !LEFT_OUT.has(manifest.name));

  // Each package's box: its own, or its group's.
  const boxOf = new Map(
    found.map(({ directory, manifest }) => {
      const group = GROUPS.find((g) => `${directory}/`.startsWith(g.directory));
      return [
        manifest.name,
        group === undefined
          ? { name: manifest.name, directory }
          : { name: group.name, directory: group.label },
      ];
    }),
  );
  const boxes = new Map<string, WorkspacePackage>();
  for (const { manifest } of found) {
    const { name, directory } = boxOf.get(manifest.name)!;
    const box = boxes.get(name) ?? { directory, runtime: [], dev: [] };
    const into = (deps: Readonly<Record<string, string>> = {}) =>
      Object.keys(deps).flatMap((dep) => {
        const target = boxOf.get(dep)?.name;
        return target === undefined || target === name ? [] : [target];
      });
    box.runtime = sortedNames(
      new Set([...box.runtime, ...into(manifest.dependencies)]),
    );
    box.dev = sortedNames(
      new Set([...box.dev, ...into(manifest.devDependencies)]),
    );
    boxes.set(name, box);
  }
  return new Map(
    sortedNames(boxes.keys()).map((name) => [name, boxes.get(name)!]),
  );
}

function reachable(
  edges: ReadonlyMap<string, readonly string[]>,
  from: string,
  seen = new Set<string>(),
): Set<string> {
  for (const next of edges.get(from) ?? []) {
    if (!seen.has(next)) {
      seen.add(next);
      reachable(edges, next, seen);
    }
  }
  return seen;
}

// A dependency is drawn unless another of the package's dependencies already reaches it. A
// runtime dependency counts as reached only through runtime dependencies, so a dev dependency
// never stands in for one.
function drawnEdges(workspace: ReadonlyMap<string, WorkspacePackage>) {
  const entries = [...workspace];
  const runtime = new Map(
    entries.map(([name, { runtime }]) => [name, runtime]),
  );
  const all = new Map(
    entries.map(([name, { runtime, dev }]) => [name, [...runtime, ...dev]]),
  );
  return entries.flatMap(([from, pkg]) =>
    [
      ...pkg.runtime.map((to) => ({ from, to, dev: false })),
      ...pkg.dev
        .filter((to) => !pkg.runtime.includes(to))
        .map((to) => ({ from, to, dev: true })),
    ].filter(({ to, dev }) => {
      const through = dev ? all : runtime;
      return !through
        .get(from)!
        .some((other) => other !== to && reachable(through, other).has(to));
    }),
  );
}

// A line through the points dagre routes an edge along, bending at each through its midpoints.
function curve(points: readonly Point[]): string {
  const at = ({ x, y }: Point) => `${x.toFixed(1)},${y.toFixed(1)}`;
  let d = `M${at(points[0]!)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [p, next] = [points[i]!, points[i + 1]!];
    d += ` Q${at(p)} ${at({ x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 })}`;
  }
  return `${d} L${at(points.at(-1)!)}`;
}

export function dependencyGraph() {
  const workspace = readWorkspace();
  const edges = drawnEdges(workspace);

  // Top to bottom, from each package to what it depends on.
  const graph = new graphlib.Graph();
  graph.setGraph({
    rankdir: "TB",
    nodesep: 24,
    ranksep: 56,
    marginx: 20,
    marginy: 20,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const name of workspace.keys()) {
    graph.setNode(name, { width: BOX_WIDTH, height: BOX_HEIGHT });
  }
  for (const { from, to } of edges) graph.setEdge(from, to);
  layout(graph);

  const { width, height } = graph.graph() as { width: number; height: number };
  return {
    width,
    height,
    // dagre gives each package's centre.
    boxes: [...workspace].map(([name, { directory }]) => {
      const { x, y } = graph.node(name) as Point;
      return {
        name,
        directory,
        published: name.startsWith("@govuk-once/"),
        x: x - BOX_WIDTH / 2,
        y: y - BOX_HEIGHT / 2,
      };
    }),
    // A dev line is a dev dependency only, such as the shared types the published client bundles.
    lines: edges.map((edge) => ({
      ...edge,
      path: curve(
        (graph.edge(edge.from, edge.to) as { points: Point[] }).points,
      ),
    })),
    // Each package and what it depends on directly, as the diagram's text alternative.
    description: [...workspace]
      .map(
        ([name, { runtime, dev }]) =>
          `${name} depends on ${runtime.length > 0 ? runtime.join(", ") : "no other package"}${dev.length > 0 ? `, with the dev dependencies ${dev.join(", ")}` : ""}.`,
      )
      .join(" "),
  };
}
