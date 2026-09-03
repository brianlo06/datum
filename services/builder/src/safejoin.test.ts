import { describe, expect, it } from "vitest";
import { safeJoin, UnsafeFilenameError } from "./openscad.js";

const ROOT = "/tmp/datum-build-xyz";

describe("safeJoin", () => {
  it("accepts a plain filename", () => {
    expect(safeJoin(ROOT, "main.scad")).toBe(`${ROOT}/main.scad`);
  });

  it("accepts a nested path", () => {
    expect(safeJoin(ROOT, "parts/bracket.scad")).toBe(`${ROOT}/parts/bracket.scad`);
  });

  it("accepts the real-world filenames a character whitelist rejected", () => {
    // These all exist in the audited corpus and were previously 400s.
    expect(safeJoin(ROOT, "Steady Rest.scad")).toBe(`${ROOT}/Steady Rest.scad`);
    expect(safeJoin(ROOT, "custom-models/Kwikset KW1.scad")).toBe(
      `${ROOT}/custom-models/Kwikset KW1.scad`,
    );
    expect(safeJoin(ROOT, "Bracket (v2).scad")).toBe(`${ROOT}/Bracket (v2).scad`);
    expect(safeJoin(ROOT, "boîtier.scad")).toBe(`${ROOT}/boîtier.scad`);
    expect(safeJoin(ROOT, "part#3.scad")).toBe(`${ROOT}/part#3.scad`);
  });

  it("normalises a harmless interior traversal that stays inside", () => {
    expect(safeJoin(ROOT, "a/../b.scad")).toBe(`${ROOT}/b.scad`);
    expect(safeJoin(ROOT, "./main.scad")).toBe(`${ROOT}/main.scad`);
  });

  it("refuses to escape upwards", () => {
    expect(() => safeJoin(ROOT, "../escape.scad")).toThrow(UnsafeFilenameError);
    expect(() => safeJoin(ROOT, "a/../../escape.scad")).toThrow(UnsafeFilenameError);
    expect(() => safeJoin(ROOT, "../../etc/passwd")).toThrow(UnsafeFilenameError);
  });

  it("refuses an absolute path", () => {
    expect(() => safeJoin(ROOT, "/etc/passwd")).toThrow(UnsafeFilenameError);
  });

  it("refuses backslashes, so Windows-style traversal cannot slip through", () => {
    expect(() => safeJoin(ROOT, "..\\escape.scad")).toThrow(UnsafeFilenameError);
    expect(() => safeJoin(ROOT, "a\\b.scad")).toThrow(UnsafeFilenameError);
  });

  it("refuses empty and NUL-bearing names", () => {
    expect(() => safeJoin(ROOT, "")).toThrow(UnsafeFilenameError);
    expect(() => safeJoin(ROOT, "a\0b.scad")).toThrow(UnsafeFilenameError);
  });

  it("refuses a name that resolves to the build directory itself", () => {
    expect(() => safeJoin(ROOT, ".")).toThrow(UnsafeFilenameError);
    expect(() => safeJoin(ROOT, "a/..")).toThrow(UnsafeFilenameError);
  });

  it("is not fooled by a sibling directory sharing the root's prefix", () => {
    // /tmp/datum-build-xyz-evil must not count as inside /tmp/datum-build-xyz.
    expect(() => safeJoin(ROOT, "../datum-build-xyz-evil/x.scad")).toThrow(UnsafeFilenameError);
  });
});
