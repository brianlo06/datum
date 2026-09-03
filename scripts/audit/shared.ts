/**
 * Helpers shared between the audit scripts: walking a cloned repository,
 * choosing which sibling files to ship with an entry, and deriving the search
 * paths that make installed-style includes resolve. Kept together so a retry
 * run builds each part under exactly the same conditions as the main audit.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export const MAX_FILE_BYTES = 400_000;
export const MAX_PAYLOAD_BYTES = 18_000_000;

export interface ScadFile {
  path: string;
  size: number;
}

/** Every .scad file in the repository, with sizes, as repo-relative paths. */
export async function walkRepo(dir: string): Promise<ScadFile[]> {
  const paths = await walk(dir);
  const out: ScadFile[] = [];
  for (const p of paths) {
    try {
      out.push({ path: p, size: (await stat(join(dir, p))).size });
    } catch {
      /* vanished between listing and stat */
    }
  }
  return out;
}

async function walk(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, base, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".scad")) out.push(relative(base, full));
  }
  return out;
}

/**
 * Directories to put on OPENSCADPATH for a repository.
 *
 * Many projects are written to be installed rather than vendored: their examples
 * say `include <src/thing.scad>` or `include <theproject/thing.scad>`. The audit
 * reproduces an install by offering the repo root and its conventional library
 * directories as search paths.
 */
export function searchPathsFor(files: ScadFile[]): string[] {
  const dirs = new Set<string>(["."]);
  const CONVENTIONAL = ["src", "lib", "libs", "libraries", "modules", "scad", "include"];
  for (const f of files) {
    const parts = f.path.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      if (CONVENTIONAL.includes(seg.toLowerCase())) dirs.add(parts.slice(0, i + 1).join("/"));
    }
    // A single top-level directory holding .scad files is very often the library.
    if (parts.length === 2) dirs.add(parts[0]!);
  }
  return [...dirs];
}

/**
 * Choose which sibling files to ship with the entry, nearest first.
 * OpenSCAD resolves includes relative to the including file, so files in the
 * same directory and its ancestors are the ones most likely to be needed.
 */
export function selectFiles(
  all: ScadFile[],
  entry: string,
  budget: number,
): { paths: string[]; truncated: boolean } {
  const entryDir = dirname(entry);
  const distance = (p: string) => {
    const d = dirname(p);
    if (d === entryDir) return 0;
    if (entryDir.startsWith(d)) return 1 + (entryDir.split("/").length - d.split("/").length);
    if (d.startsWith(entryDir)) return 1 + (d.split("/").length - entryDir.split("/").length);
    return 50 + d.split("/").length;
  };

  const sorted = [...all].sort((a, b) => distance(a.path) - distance(b.path) || a.path.localeCompare(b.path));
  const paths: string[] = [];
  let used = 0;
  let truncated = false;
  for (const f of sorted) {
    if (f.size > MAX_FILE_BYTES) {
      truncated = true;
      continue;
    }
    if (used + f.size > budget) {
      truncated = true;
      continue;
    }
    paths.push(f.path);
    used += f.size;
  }
  return { paths, truncated };
}

/** The sibling-file payload for an entry, selected and read, ready to send. */
export async function filesFor(
  dir: string,
  all: ScadFile[],
  entry: string,
  sourceBytes: number,
): Promise<{ files: Record<string, string>; truncated: boolean }> {
  const { paths, truncated } = selectFiles(
    all.filter((f) => f.path !== entry),
    entry,
    MAX_PAYLOAD_BYTES - sourceBytes,
  );
  const files: Record<string, string> = {};
  for (const p of paths) {
    try {
      files[p] = await readFile(join(dir, p), "utf8");
    } catch {
      /* skip */
    }
  }
  return { files, truncated };
}
