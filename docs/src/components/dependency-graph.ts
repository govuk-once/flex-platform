// The workspace's packages and what each depends on, read from their manifests as the site builds,
// and laid out by dagre in layers: each package sits above everything it depends on, inside its
// section. A dependency already reached through another is not drawn, nor one on a package any
// package may use, so the diagram shows the structure rather than every line a manifest holds.

import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";

import { graphlib, layout } from "@dagrejs/dagre";
import { heldValue } from "@repo/utils/held-value";
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

// Each package sits in its section's box, by the first folder of its directory.
const SECTIONS = new Map([
  ["domains", "Domains"],
  ["frontdoor", "Frontdoor"],
  ["gateways", "Gateways"],
  ["infra", "Infrastructure"],
  ["packages", "Packages"],
  ["shared", "Shared account"],
]);

// Any package may use these, and neither depends on another workspace package, so an arrow to
// either would only cross the diagram. They are drawn, without the arrows into them.
const ANY_PACKAGE_MAY_USE = new Set([
  "@repo/cloudfront-js-utils",
  "@repo/utils",
]);

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
    const glob = /^\s+-\s+"?([^"]+?)"?\s*$/.exec(line)?.[1];
    if (glob === undefined) break;
    globs.push(glob);
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
    const { name, directory } = heldValue(boxOf, manifest.name);
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
    sortedNames(boxes.keys()).map((name) => [name, heldValue(boxes, name)]),
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
      return !heldValue(through, from).some(
        (other) => other !== to && reachable(through, other).has(to),
      );
    }),
  );
}

function sectionOf(directory: string): string {
  const folder = directory.split("/")[0] ?? "";
  const section = SECTIONS.get(folder);
  if (section === undefined) {
    throw new Error(
      `No section for packages in ${folder}/: add it to SECTIONS`,
    );
  }
  return section;
}

// dagre places the packages and the sections, and finds where each edge can pass the rows between
// its ends. The diagram then draws each edge in right angles, turning only in the gaps between
// rows, and makes each gap as tall as the edges that cross it need.

const MARGIN = 20;
// Around a section's packages, and above them for its title.
const SECTION_PADDING = 16;
const TITLE_SPACE = 32;
// Between the top or bottom of a gap and a run across it, and between two runs.
const RUN_MARGIN = 14;
const RUN_SPACING = 10;
// How near a box's corner an edge leaves or enters it, and how near another edge doing the same.
const PORT_MARGIN = 16;
const PORT_SPACING = 20;
// The least room an edge straightened onto a box's corner keeps from it.
const CORNER = 6;
// How far an edge passing a row stays from that row's boxes.
const CLEARANCE = 10;

interface Span {
  readonly left: number;
  readonly right: number;
}

interface Box extends Span {
  readonly row: number;
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Nothing at index ${index.toString()}`);
  }
  return value;
}

const clamp = (x: number, { left, right }: Span) =>
  Math.min(right, Math.max(left, x));

const centreOf = ({ left, right }: Span) => (left + right) / 2;

// Spreads the edges that leave or enter one box along its side, in the order of where each is
// headed, so none crosses another as it leaves. Each is placed as near as it can be to where it
// would run straight, at least PORT_SPACING from its neighbours. Any pushed past the
// box's end are pushed back, and only as far as they must be.
function placePorts(box: Span, wanted: readonly number[]): number[] {
  const range = {
    left: box.left + PORT_MARGIN,
    right: box.right - PORT_MARGIN,
  };
  const order = wanted
    .map((x, i) => ({ x: clamp(x, range), wanted: x, i }))
    .sort((a, b) => a.x - b.x || a.wanted - b.wanted || a.i - b.i);
  const xs = order.map(({ x }) => x);
  for (let k = 1; k < xs.length; k++) {
    xs[k] = Math.max(at(xs, k), at(xs, k - 1) + PORT_SPACING);
  }
  for (let k = xs.length - 1; k >= 0; k--) {
    const after = xs[k + 1];
    xs[k] = Math.max(
      range.left,
      Math.min(
        at(xs, k),
        range.right,
        after === undefined ? Infinity : after - PORT_SPACING,
      ),
    );
  }
  const placed = wanted.map(() => 0);
  order.forEach(({ i }, k) => {
    placed[i] = at(xs, k);
  });
  return placed;
}

function isClear(x: number, row: readonly Span[]): boolean {
  return row.every(
    ({ left, right }) => x < left - CLEARANCE || x > right + CLEARANCE,
  );
}

export function dependencyGraph() {
  const workspace = readWorkspace();
  const names = [...workspace.keys()];
  const edges = drawnEdges(workspace).filter(
    ({ to }) => !ANY_PACKAGE_MAY_USE.has(to),
  );

  // Top to bottom, from each package to what it depends on, each inside its section.
  const graph = new graphlib.Graph({ compound: true });
  graph.setGraph({ rankdir: "TB", nodesep: 24, ranksep: 40, marginx: MARGIN });
  graph.setDefaultEdgeLabel(() => ({}));
  const sectionOfPackage = new Map<string, string>();
  for (const [name, { directory }] of workspace) {
    const section = sectionOf(directory);
    sectionOfPackage.set(name, section);
    graph.setNode(section, {});
    graph.setNode(name, { width: BOX_WIDTH, height: BOX_HEIGHT });
    graph.setParent(name, section);
  }
  for (const { from, to } of edges) graph.setEdge(from, to);
  layout(graph);

  // dagre gives each package's centre. Packages whose centres are level make a row.
  const centre = (name: string) => graph.node(name) as Point;
  const levels = [...new Set(names.map((name) => centre(name).y))].sort(
    (a, b) => a - b,
  );
  const boxes = new Map<string, Box>(
    names.map((name) => {
      const { x, y } = centre(name);
      return [
        name,
        {
          left: x - BOX_WIDTH / 2,
          right: x + BOX_WIDTH / 2,
          row: levels.indexOf(y),
        },
      ];
    }),
  );
  const rows = levels.map((_, row) =>
    [...boxes.values()].filter((box) => box.row === row),
  );

  // Each edge, with where dagre passes it through each row between its ends, and the x it takes
  // at each row from its first to its last.
  const routes = edges.map((edge) => {
    const from = heldValue(boxes, edge.from);
    const to = heldValue(boxes, edge.to);
    const points = (graph.edge(edge.from, edge.to) as { points: Point[] })
      .points;
    const passes = new Map<number, number>();
    for (let row = from.row + 1; row < to.row; row++) {
      const level = at(levels, row);
      const point = points.find((p) => Math.abs(p.y - level) < 1);
      if (point !== undefined) passes.set(row, point.x);
    }
    return { edge, from, to, passes, xs: [] as number[] };
  });

  // An edge leaves its package below where it goes next, as near as the box allows.
  for (const [name, box] of boxes) {
    const leaving = routes.filter(({ edge }) => edge.from === name);
    const wanted = leaving.map(
      ({ to, passes }) => passes.get(box.row + 1) ?? centreOf(to),
    );
    placePorts(box, wanted).forEach((x, k) => {
      at(leaving, k).xs.push(x);
    });
  }

  // It goes straight down past each row it can, and otherwise where dagre passed it.
  for (const { from, to, passes, xs } of routes) {
    for (let row = from.row + 1; row < to.row; row++) {
      const x = at(xs, xs.length - 1);
      xs.push(isClear(x, at(rows, row)) ? x : (passes.get(row) ?? x));
    }
  }

  // It enters its package above where it arrives, as near as the box allows.
  for (const [name, box] of boxes) {
    const entering = routes.filter(({ edge }) => edge.to === name);
    const wanted = entering.map(({ xs }) => at(xs, xs.length - 1));
    placePorts(box, wanted).forEach((x, k) => {
      at(entering, k).xs.push(x);
    });
  }

  // An edge between neighbouring rows that turns by less than PORT_SPACING, because its ports
  // were spread or kept from a corner, leaves its package where it enters the next instead, if
  // that is inside the box and clear of the box's other edges.
  for (const { from, to, xs } of routes) {
    const start = at(xs, 0);
    const end = at(xs, xs.length - 1);
    const turn = Math.abs(end - start);
    if (to.row !== from.row + 1 || turn < 1 || turn >= PORT_SPACING) continue;
    const others = routes
      .filter((route) => route.from === from && route.xs !== xs)
      .map((route) => at(route.xs, 0));
    if (
      end >= from.left + CORNER &&
      end <= from.right - CORNER &&
      others.every((x) => Math.abs(x - end) >= PORT_SPACING)
    ) {
      xs[0] = end;
    }
  }

  // Each turn is a run across the gap above a row. The runs in a gap are stacked from its top, the
  // longest first, so each can be followed on its own and no shorter run's drop crosses a longer
  // run.
  const runs = routes.map(({ xs }) =>
    xs.map((): number | undefined => undefined),
  );
  const gaps = new Map<
    number,
    { route: number; turn: number; length: number; left: number }[]
  >();
  routes.forEach(({ from, xs }, route) => {
    xs.forEach((x, turn) => {
      const before = xs[turn - 1];
      if (before === undefined || Math.abs(x - before) < 1) return;
      const gap = from.row + turn;
      const inGap = gaps.get(gap) ?? [];
      inGap.push({
        route,
        turn,
        length: Math.abs(x - before),
        left: Math.min(x, before),
      });
      gaps.set(gap, inGap);
    });
  });
  for (const inGap of gaps.values()) {
    inGap.sort((a, b) => b.length - a.length || a.left - b.left);
    inGap.forEach(({ route, turn }, k) => {
      at(runs, route)[turn] = k;
    });
  }

  // Where each section starts and ends, by row.
  const sections = sortedNames(new Set(sectionOfPackage.values())).map(
    (title) => {
      const members = names.filter(
        (name) => sectionOfPackage.get(name) === title,
      );
      const memberRows = members.map((name) => heldValue(boxes, name).row);
      return {
        title,
        top: Math.min(...memberRows),
        bottom: Math.max(...memberRows),
      };
    },
  );
  const opens = (row: number) => sections.some(({ top }) => top === row);
  const closes = (row: number) => sections.some(({ bottom }) => bottom === row);

  // Each row's top. A gap holds the bottom of the sections that end above it, its runs, and the
  // top and title of the sections that start below it.
  const tops = [MARGIN + (opens(0) ? SECTION_PADDING + TITLE_SPACE : 0)];
  const runTops = [0];
  for (let row = 1; row < levels.length; row++) {
    const bottom = at(tops, row - 1) + BOX_HEIGHT;
    const count = gaps.get(row)?.length ?? 0;
    const closing = closes(row - 1) ? SECTION_PADDING : 0;
    const opening = opens(row) ? SECTION_PADDING + TITLE_SPACE : 0;
    runTops.push(bottom + closing + RUN_MARGIN);
    tops.push(
      bottom +
        closing +
        2 * RUN_MARGIN +
        Math.max(0, count - 1) * RUN_SPACING +
        opening,
    );
  }
  const last = levels.length - 1;
  const height =
    at(tops, last) + BOX_HEIGHT + (closes(last) ? SECTION_PADDING : 0) + MARGIN;

  const lines = routes.map(({ edge, from, to, xs }, route) => {
    const n = (value: number) => value.toFixed(1);
    let d = `M${n(at(xs, 0))},${n(at(tops, from.row) + BOX_HEIGHT)}`;
    xs.forEach((x, turn) => {
      const run = at(runs, route)[turn];
      if (run !== undefined) {
        d += ` V${n(at(runTops, from.row + turn) + run * RUN_SPACING)} H${n(x)}`;
      }
    });
    return { ...edge, path: `${d} V${n(at(tops, to.row))}` };
  });

  const { width } = graph.graph() as { width: number };
  return {
    width,
    height,
    boxes: [...workspace].map(([name, { directory }]) => {
      const box = heldValue(boxes, name);
      return {
        name,
        directory,
        published: name.startsWith("@govuk-once/"),
        x: box.left,
        y: at(tops, box.row),
      };
    }),
    // dagre gives each section's width around its packages and the edges that pass them.
    sections: sections.map(({ title, top, bottom }) => {
      const node = graph.node(title) as Point & { width: number };
      const y = at(tops, top) - SECTION_PADDING - TITLE_SPACE;
      return {
        title,
        x: node.x - node.width / 2,
        y,
        width: node.width,
        height: at(tops, bottom) + BOX_HEIGHT + SECTION_PADDING - y,
      };
    }),
    // A dev line is a dev dependency only, such as the shared types the published client bundles.
    lines,
    // Each package and what it depends on directly, as the diagram's text alternative.
    description: [...workspace]
      .map(
        ([name, { runtime, dev }]) =>
          `${name} depends on ${runtime.length > 0 ? runtime.join(", ") : "no other package"}${dev.length > 0 ? `, with the dev dependencies ${dev.join(", ")}` : ""}.`,
      )
      .join(" "),
  };
}
