import fs from "node:fs";
import path from "node:path";

// Minimal find-up. ESLint's includeIgnoreFile() needs an absolute path to the repo .gitignore,
// but each package lints from its own directory and there is no root config to anchor a relative
// path against, so we walk up to find it. Not worth a dependency for ~10 lines.
export function findUpSync(filename: string, startDir?: string): string {
  let dir = startDir ?? process.cwd();
  while (true) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not find ${filename} in any parent directory`);
    }
    dir = parent;
  }
}
