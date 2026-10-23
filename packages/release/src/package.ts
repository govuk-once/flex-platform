import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { isRecord } from "@repo/utils/is-record";
import { sortedNames } from "@repo/utils/sorted-names";

// A built package as it is published: its digest, which the record keeps, and its tarball. Both
// hold every file the build wrote, with the manifest it is published under in place of the built
// one, so what is digested is what is published.

const MANIFEST = "package.json";

// JSON with every object's keys sorted, so a manifest's digest does not depend on the order a
// build wrote its fields in.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${sortedNames(Object.keys(value))
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// Each file in the package, by its path in it, in order. The manifest is always there, whether or
// not the build wrote one.
async function packageFiles(builtDir: string): Promise<string[]> {
  const entries = await readdir(builtDir, {
    recursive: true,
    withFileTypes: true,
  });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(builtDir, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    );
  return sortedNames(new Set([...files, MANIFEST]));
}

// The digest of the package. The manifest's own version is left out: it is what a release decides,
// so the digest says whether there is anything to decide. It is taken over the files, not the
// tarball, since gzip output can differ between zlib builds, and a laptop and a runner must agree.
export async function contentDigest(
  builtDir: string,
  manifest: Readonly<Record<string, unknown>>,
): Promise<string> {
  const unversioned = { ...manifest };
  delete unversioned.version;
  const hash = createHash("sha256");
  for (const file of await packageFiles(builtDir)) {
    const content =
      file === MANIFEST
        ? canonical(unversioned)
        : await readFile(path.join(builtDir, file));
    hash.update(
      `${file}\0${createHash("sha256").update(content).digest("hex")}\n`,
    );
  }
  return `sha256:${hash.digest("hex")}`;
}

export function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

const BLOCK = 512;
// The time npm gives every file it packs, so a tarball does not depend on when it was built.
const MTIME = 499162500;

// A ustar header. A path longer than the name field holds is split at a slash into the prefix.
function tarHeader(file: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK);
  let [prefix, name] = ["", file];
  if (Buffer.byteLength(file) > 100) {
    const cut = file.lastIndexOf("/", 155);
    [prefix, name] = [file.slice(0, cut), file.slice(cut + 1)];
    if (cut < 1 || Buffer.byteLength(name) > 100) {
      throw new Error(`${file} is too long a path to pack.`);
    }
  }
  const octal = (value: number, offset: number, length: number) =>
    header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset);
  header.write(name, 0);
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(MTIME, 136, 12);
  header.write("0", 156);
  header.write("ustar\0" + "00", 257);
  header.write(prefix, 345);
  // The checksum is taken with its own field as spaces.
  header.write(" ".repeat(8), 148);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}

// Packs the package into a tarball at `file`, as npm lays one out: every file under `package/`.
export async function packPackage(
  builtDir: string,
  manifest: Readonly<Record<string, unknown>>,
  file: string,
): Promise<void> {
  const blocks: Buffer[] = [];
  for (const name of await packageFiles(builtDir)) {
    const content =
      name === MANIFEST
        ? Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
        : await readFile(path.join(builtDir, name));
    blocks.push(
      tarHeader(`package/${name}`, content.length),
      content,
      Buffer.alloc((BLOCK - (content.length % BLOCK)) % BLOCK),
    );
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  await writeFile(file, gzipSync(Buffer.concat(blocks)));
}
