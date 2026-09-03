import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLibrarySet } from "./libraries.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "datum-libs-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

describe("readLibrarySet", () => {
  it("reads the manifest and digest written by the vendoring script", async () => {
    const dir = await fixture({
      "digest.txt": "",
      digest: "abc123\n",
      "manifest.json": JSON.stringify({
        libraries: [
          { name: "BOSL2", version: "v2.0.753", license: "BSD-2-Clause", include: "BOSL2/std.scad", ref: "fcfce7c" },
        ],
      }),
    });
    const set = await readLibrarySet(dir);
    expect(set.digest).toBe("abc123");
    expect(set.libraries).toHaveLength(1);
    expect(set.libraries[0]!.name).toBe("BOSL2");
    expect(set.libraries[0]!.license).toBe("BSD-2-Clause");
  });

  it("treats a missing library directory as an empty set rather than an error", async () => {
    const set = await readLibrarySet(join(tmpdir(), "definitely-not-here-xyz"));
    expect(set.digest).toBe("none");
    expect(set.libraries).toEqual([]);
  });

  it("survives a corrupt manifest without taking the builder down", async () => {
    const dir = await fixture({ digest: "abc\n", "manifest.json": "{ not json" });
    const set = await readLibrarySet(dir);
    expect(set.libraries).toEqual([]);
  });

  it("tolerates a manifest with no libraries array", async () => {
    const dir = await fixture({ digest: "abc\n", "manifest.json": "{}" });
    const set = await readLibrarySet(dir);
    expect(set.digest).toBe("abc");
    expect(set.libraries).toEqual([]);
  });
});
