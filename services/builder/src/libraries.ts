import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The vendored library set.
 *
 * Read once at startup from the manifest the image was built with. The digest
 * identifies the exact set of pinned commits, and the API folds it into every
 * build hash: geometry depends on these libraries, so bumping one must
 * invalidate cached artifacts rather than serve stale geometry under an
 * unchanged content address.
 */

export interface VendoredLibrary {
  name: string;
  version: string;
  license: string;
  include: string;
  ref: string;
}

export interface LibrarySet {
  digest: string;
  libraries: VendoredLibrary[];
}

const DIR = process.env.OPENSCAD_LIBRARY_DIR ?? "/opt/openscad-libraries";

const EMPTY: LibrarySet = { digest: "none", libraries: [] };

let cached: LibrarySet | null = null;

/** Load the library set installed at `dir` by vendor-libraries.sh. */
export async function readLibrarySet(dir: string): Promise<LibrarySet> {
  try {
    const [manifestRaw, digestRaw] = await Promise.all([
      readFile(join(dir, "manifest.json"), "utf8"),
      readFile(join(dir, "digest"), "utf8"),
    ]);
    const manifest = JSON.parse(manifestRaw) as { libraries: VendoredLibrary[] };
    return {
      digest: digestRaw.trim(),
      libraries: (manifest.libraries ?? []).map((l) => ({
        name: l.name,
        version: l.version,
        license: l.license,
        include: l.include,
        ref: l.ref,
      })),
    };
  } catch {
    // No vendored libraries is a valid configuration, not an error: the sandbox
    // still builds anything that is self-contained.
    return EMPTY;
  }
}

export async function librarySet(): Promise<LibrarySet> {
  cached ??= await readLibrarySet(DIR);
  return cached;
}
