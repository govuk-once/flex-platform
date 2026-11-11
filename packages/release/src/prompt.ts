import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";

import { GroupMultiSelectPrompt } from "@clack/core";
import {
  cancel,
  isCancel,
  limitOptions,
  S_BAR,
  S_BAR_END,
  S_CHECKBOX_ACTIVE,
  S_CHECKBOX_INACTIVE,
  S_CHECKBOX_SELECTED,
  select,
  symbol,
} from "@clack/prompts";
import { heldValue } from "@repo/utils/held-value";

import type { Choice, Chooser, Lock } from "./prepare.ts";
import { type Bump, bumped } from "./versions.ts";
import { nameOf } from "./workspace.ts";

// Choosing a release at the terminal. Every package is listed, grouped by where it comes from.
// Ticking one with unreleased changes ticks everything it brings with it, marked with why and in
// yellow rather than green, and those stay ticked until nothing chosen needs them. A package with no changes of its own is only
// ever ticked that way. Ticking a group's name chooses or clears every package in it with changes.
// Space acts on what a box shows: clearing a ticked one that something chosen needs leaves it as it
// is, and choosing never takes a package that is already ticked.

interface Item {
  readonly value: string;
  readonly group?: string | boolean;
}

/** What is chosen once `target`, a package or a group's packages, is ticked or cleared. */
export function toggled(
  chosen: ReadonlySet<string>,
  target: readonly string[],
  pending: ReadonlySet<string>,
  locked: ReadonlyMap<string, string>,
): Set<string> {
  const members = target.filter((name) => pending.has(name));
  const ticked = (name: string) => chosen.has(name) || locked.has(name);
  const next = new Set(chosen);
  const clear = members.length > 0 && members.every(ticked);
  for (const name of members) {
    if (clear) next.delete(name);
    else if (!ticked(name)) next.add(name);
  }
  return next;
}

/**
 * How `names`, a package or a group's packages, are ticked: chosen once every one with changes
 * is, needed once all are ticked otherwise, since then something chosen has brought them with it.
 */
export function tickOf(
  names: readonly string[],
  chosen: ReadonlySet<string>,
  locked: ReadonlyMap<string, string>,
  pending: ReadonlySet<string>,
): "chosen" | "needed" | undefined {
  if (!names.every((name) => chosen.has(name) || locked.has(name))) {
    return undefined;
  }
  const choosable = names.filter((name) => pending.has(name));
  return choosable.length > 0 && choosable.every((name) => chosen.has(name))
    ? "chosen"
    : "needed";
}

function checkbox(tick: ReturnType<typeof tickOf>, active: boolean): string {
  if (tick === "chosen") return styleText("green", S_CHECKBOX_SELECTED);
  if (tick === "needed") return styleText("yellow", S_CHECKBOX_SELECTED);
  if (active) return styleText("cyan", S_CHECKBOX_ACTIVE);
  return styleText("dim", S_CHECKBOX_INACTIVE);
}

function answered<T>(answer: T): Exclude<T, symbol> {
  if (isCancel(answer)) {
    cancel("Nothing was released.");
    throw new Error("The release was cancelled.");
  }
  return answer as Exclude<T, symbol>;
}

export async function chooseRelease(
  choices: readonly Choice[],
  lock: Lock,
  /** The terminal, which tests stand in for. */
  terminal: { input?: Readable; output?: Writable } = {},
): Promise<ReadonlySet<string>> {
  const byName = new Map(choices.map((c) => [nameOf(c.pkg), c]));
  const pending = new Set(
    choices.filter((c) => c.reason !== undefined).map((c) => nameOf(c.pkg)),
  );
  const groups = new Map<string, Item[]>();
  for (const { pkg } of choices) {
    const members = groups.get(pkg.source.group) ?? [];
    members.push({ value: nameOf(pkg) });
    groups.set(pkg.source.group, members);
  }
  const membersOf = (item: Item): string[] =>
    item.group === true
      ? heldValue(groups, item.value).map((i) => i.value)
      : [item.value];
  let chosen = new Set<string>();
  let locked: ReadonlyMap<string, string> = new Map();

  const describe = (name: string): string => {
    const { released, next, reason } = heldValue(byName, name);
    const versions = `${released?.version ?? "none"} → ${next ?? "asked next"}`;
    const forced = chosen.has(name) ? undefined : locked.get(name);
    const why = [reason, forced].filter(Boolean).join(", ") || "no changes";
    const note = styleText("dim", `(${why})`);
    return `${name}  ${versions}  ${note}`;
  };
  const line = (item: Item, active: boolean): string => {
    const box = checkbox(
      tickOf(membersOf(item), chosen, locked, pending),
      active,
    );
    const text = item.group === true ? item.value : describe(item.value);
    const indent = item.group === true ? "" : "  ";
    return `${indent}${box} ${active ? text : styleText("dim", text)}`;
  };

  const prompt = new GroupMultiSelectPrompt<Item>({
    ...terminal,
    options: Object.fromEntries(groups),
    required: false,
    render() {
      const title = `${styleText("gray", S_BAR)}\n${symbol(this.state)}  Which packages are released?`;
      if (this.state === "submit") {
        const count = styleText("dim", `${chosen.size + locked.size} packages`);
        return `${title}\n${styleText("gray", S_BAR)}  ${count}`;
      }
      if (this.state === "cancel") return title;
      const lines = limitOptions({
        options: this.options,
        cursor: this.cursor,
        maxItems: 20,
        style: line,
      });
      return [
        title,
        ...lines.map((l) => `${styleText("cyan", S_BAR)}  ${l}`),
        `${styleText("cyan", S_BAR)}  ${styleText("dim", "space to choose, enter to release")}`,
        styleText("cyan", S_BAR_END),
      ].join("\n");
    },
  });
  // After the prompt's own toggle, whose effect this replaces.
  prompt.on("cursor", (action) => {
    if (action !== "space") return;
    const item = prompt.options[prompt.cursor];
    if (item === undefined) return;
    chosen = toggled(chosen, membersOf(item), pending, locked);
    locked = lock(chosen);
    prompt.value = [...chosen, ...locked.keys()];
  });

  answered(await prompt.prompt());
  return new Set([...chosen, ...locked.keys()]);
}

// A declared package whose manifest does not set its next version is raised from its last
// release by the bump chosen here, once the release is chosen.
export async function chooseBump(
  choice: Choice,
  from: string,
  /** The terminal, which tests stand in for. */
  terminal: { input?: Readable; output?: Writable } = {},
): Promise<Bump> {
  const bumps: Bump[] = ["patch", "minor", "major"];
  return answered(
    await select<Bump>({
      ...terminal,
      message: `How is ${nameOf(choice.pkg)} raised from ${from}?`,
      options: bumps.map((bump) => ({
        value: bump,
        label: `${bump}  ${bumped(from, bump)}`,
      })),
    }),
  );
}

export const terminalChooser: Chooser = {
  select: (choices, lock) => chooseRelease(choices, lock),
  bump: (choice, from) => chooseBump(choice, from),
};
