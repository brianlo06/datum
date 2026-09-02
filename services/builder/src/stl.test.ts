import { describe, expect, it } from "vitest";
import { estimateMassGrams, measure, parseStl, StlParseError, type Triangle, type Vec3 } from "./stl.js";

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** An axis-aligned box from the origin, with outward-facing winding. */
function box(sx: number, sy = sx, sz = sx): Triangle[] {
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): Triangle[] => [
    { a, b, c },
    { a, b: c, c: d },
  ];
  return [
    ...quad(v(0, 0, 0), v(0, sy, 0), v(sx, sy, 0), v(sx, 0, 0)), // z-
    ...quad(v(0, 0, sz), v(sx, 0, sz), v(sx, sy, sz), v(0, sy, sz)), // z+
    ...quad(v(0, 0, 0), v(sx, 0, 0), v(sx, 0, sz), v(0, 0, sz)), // y-
    ...quad(v(0, sy, 0), v(0, sy, sz), v(sx, sy, sz), v(sx, sy, 0)), // y+
    ...quad(v(0, 0, 0), v(0, 0, sz), v(0, sy, sz), v(0, sy, 0)), // x-
    ...quad(v(sx, 0, 0), v(sx, sy, 0), v(sx, sy, sz), v(sx, 0, sz)), // x+
  ];
}

function toBinaryStl(tris: Triangle[]): Buffer {
  const buf = Buffer.alloc(80 + 4 + tris.length * 50);
  buf.write("datum test fixture", 0, "ascii");
  buf.writeUInt32LE(tris.length, 80);
  let off = 84;
  for (const t of tris) {
    off += 12; // normal left as zeroes; the parser recomputes it
    for (const p of [t.a, t.b, t.c]) {
      buf.writeFloatLE(p.x, off);
      buf.writeFloatLE(p.y, off + 4);
      buf.writeFloatLE(p.z, off + 8);
      off += 12;
    }
    off += 2; // attribute byte count
  }
  return buf;
}

function toAsciiStl(tris: Triangle[]): Buffer {
  const lines = ["solid fixture"];
  for (const t of tris) {
    lines.push("  facet normal 0 0 0", "    outer loop");
    for (const p of [t.a, t.b, t.c]) lines.push(`      vertex ${p.x} ${p.y} ${p.z}`);
    lines.push("    endloop", "  endfacet");
  }
  lines.push("endsolid fixture");
  return Buffer.from(lines.join("\n"), "utf8");
}

describe("parseStl", () => {
  it("round-trips a binary STL", () => {
    const tris = box(10);
    const parsed = parseStl(toBinaryStl(tris));
    expect(parsed).toHaveLength(12);
    expect(parsed[0]!.a).toEqual(v(0, 0, 0));
  });

  it("round-trips an ASCII STL", () => {
    const parsed = parseStl(toAsciiStl(box(10)));
    expect(parsed).toHaveLength(12);
  });

  it("produces identical measurements from both encodings", () => {
    const tris = box(10);
    expect(measure(parseStl(toBinaryStl(tris)))).toEqual(measure(parseStl(toAsciiStl(tris))));
  });

  it("rejects an empty file", () => {
    expect(() => parseStl(Buffer.alloc(0))).toThrow(StlParseError);
  });

  it("rejects a truncated binary file rather than reading past the end", () => {
    const full = toBinaryStl(box(10));
    expect(() => parseStl(full.subarray(0, full.length - 60))).toThrow(/truncated|only/);
  });

  it("rejects an ASCII file with a partial triangle", () => {
    const text = ["solid x", "vertex 0 0 0", "vertex 1 0 0", "endsolid x"].join("\n");
    expect(() => parseStl(Buffer.from(text))).toThrow(/whole number of triangles/);
  });
});

describe("measure", () => {
  it("computes volume, area and bounds for a 10mm cube", () => {
    const m = measure(box(10));
    expect(m.triangleCount).toBe(12);
    expect(m.vertexCount).toBe(8);
    expect(m.volumeMm3).toBeCloseTo(1000, 6);
    expect(m.surfaceAreaMm2).toBeCloseTo(600, 6);
    expect(m.boundingBox.size).toEqual([10, 10, 10]);
    expect(m.boundingBox.min).toEqual([0, 0, 0]);
  });

  it("handles a non-cubic box", () => {
    const m = measure(box(40, 20, 5));
    expect(m.volumeMm3).toBeCloseTo(4000, 6);
    expect(m.boundingBox.size).toEqual([40, 20, 5]);
  });

  it("reports a closed box as watertight and solid", () => {
    const m = measure(box(10));
    expect(m.watertight).toBe(true);
    expect(m.openEdgeCount).toBe(0);
    expect(m.nonManifoldEdgeCount).toBe(0);
    expect(m.solid).toBe(true);
  });

  it("detects open edges when a face is missing", () => {
    const holed = box(10).slice(0, 11);
    const m = measure(holed);
    expect(m.watertight).toBe(false);
    expect(m.openEdgeCount).toBeGreaterThan(0);
    expect(m.solid).toBe(false);
  });

  it("detects a non-manifold edge shared by three faces", () => {
    const tris = box(10);
    // A stray flap hanging off one of the cube's existing edges.
    tris.push({ a: v(0, 0, 0), b: v(0, 10, 0), c: v(-5, 5, 0) });
    const m = measure(tris);
    expect(m.nonManifoldEdgeCount).toBe(1);
    expect(m.watertight).toBe(false);
  });

  it("reports negative volume for inverted winding rather than silently absolute", () => {
    const flipped = box(10).map((t) => ({ a: t.a, b: t.c, c: t.b }));
    const m = measure(flipped);
    expect(m.volumeMm3).toBeCloseTo(-1000, 6);
    expect(m.solid).toBe(false);
  });

  it("counts degenerate triangles", () => {
    const tris = box(10);
    tris.push({ a: v(1, 1, 1), b: v(1, 1, 1), c: v(1, 1, 1) });
    expect(measure(tris).degenerateTriangleCount).toBe(1);
  });

  it("returns a defined empty result for a build that produced no geometry", () => {
    const m = measure([]);
    expect(m.triangleCount).toBe(0);
    expect(m.solid).toBe(false);
    expect(m.volumeMm3).toBe(0);
    expect(m.boundingBox.size).toEqual([0, 0, 0]);
  });

  it("treats vertices within float noise as the same point", () => {
    const tris = box(10);
    // Nudge one shared corner by less than the quantisation epsilon.
    const nudged = tris.map((t) => ({
      a: t.a.x === 0 && t.a.y === 0 && t.a.z === 0 ? v(1e-9, 0, 0) : t.a,
      b: t.b,
      c: t.c,
    }));
    expect(measure(nudged).watertight).toBe(true);
  });
});

describe("estimateMassGrams", () => {
  it("converts volume to mass for a known material", () => {
    // 1000 mm3 = 1 cm3; PETG is 1.27 g/cm3.
    expect(estimateMassGrams(1000, "PETG")).toBeCloseTo(1.27, 6);
    expect(estimateMassGrams(1000, "petg")).toBeCloseTo(1.27, 6);
  });

  it("returns null for a material it does not know", () => {
    expect(estimateMassGrams(1000, "unobtanium")).toBeNull();
  });
});
