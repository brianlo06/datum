/**
 * STL parsing and geometry measurement.
 *
 * This is the "dimension report" the product brief calls for: the objective,
 * machine-checkable answer to "what did this build actually produce?". It is
 * deliberately independent of OpenSCAD so it can be tested without a CAD kernel,
 * and so a second kernel (build123d) can reuse it later.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface BoundingBox {
  min: [number, number, number];
  max: [number, number, number];
  /** max - min, in millimetres. */
  size: [number, number, number];
}

export interface MeshMetrics {
  triangleCount: number;
  /** Distinct vertex positions after quantisation. */
  vertexCount: number;
  boundingBox: BoundingBox;
  /** Signed volume in cubic millimetres; negative means inverted normals. */
  volumeMm3: number;
  surfaceAreaMm2: number;
  /** True when every edge is shared by exactly two triangles. */
  watertight: boolean;
  /** Edges used by only one triangle, or by three or more. */
  openEdgeCount: number;
  nonManifoldEdgeCount: number;
  /** Triangles with zero area, which slicers handle inconsistently. */
  degenerateTriangleCount: number;
  /** True when the mesh encloses a positive volume and has no open edges. */
  solid: boolean;
}

const BINARY_HEADER_BYTES = 80;
const BINARY_TRIANGLE_BYTES = 50;

/** Quantisation for vertex identity, in millimetres. Below typical CAD tolerance. */
const EPSILON = 1e-6;

export class StlParseError extends Error {}

function looksAscii(buf: Buffer): boolean {
  // A binary STL declares its triangle count in bytes 80..84; if that count
  // matches the file length exactly, trust it regardless of the header text.
  if (buf.length >= BINARY_HEADER_BYTES + 4) {
    const count = buf.readUInt32LE(BINARY_HEADER_BYTES);
    const expected = BINARY_HEADER_BYTES + 4 + count * BINARY_TRIANGLE_BYTES;
    if (expected === buf.length) return false;
  }
  const head = buf.subarray(0, Math.min(512, buf.length)).toString("utf8").trimStart();
  return head.startsWith("solid") && /facet\s+normal|endsolid/.test(head + buf.subarray(0, 2048).toString("utf8"));
}

export interface Triangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
}

export function parseStl(buf: Buffer): Triangle[] {
  if (buf.length === 0) throw new StlParseError("STL file is empty");
  return looksAscii(buf) ? parseAsciiStl(buf.toString("utf8")) : parseBinaryStl(buf);
}

function parseBinaryStl(buf: Buffer): Triangle[] {
  if (buf.length < BINARY_HEADER_BYTES + 4) throw new StlParseError("STL file is truncated");
  const count = buf.readUInt32LE(BINARY_HEADER_BYTES);
  const expected = BINARY_HEADER_BYTES + 4 + count * BINARY_TRIANGLE_BYTES;
  if (buf.length < expected) {
    throw new StlParseError(
      `STL declares ${count} triangles but the file holds only ${Math.max(
        0,
        Math.floor((buf.length - BINARY_HEADER_BYTES - 4) / BINARY_TRIANGLE_BYTES),
      )}`,
    );
  }
  const tris: Triangle[] = new Array(count);
  let off = BINARY_HEADER_BYTES + 4;
  for (let i = 0; i < count; i++) {
    // Bytes 0..12 are the stored normal, which we recompute rather than trust.
    const base = off + 12;
    tris[i] = {
      a: { x: buf.readFloatLE(base), y: buf.readFloatLE(base + 4), z: buf.readFloatLE(base + 8) },
      b: { x: buf.readFloatLE(base + 12), y: buf.readFloatLE(base + 16), z: buf.readFloatLE(base + 20) },
      c: { x: buf.readFloatLE(base + 24), y: buf.readFloatLE(base + 28), z: buf.readFloatLE(base + 32) },
    };
    off += BINARY_TRIANGLE_BYTES;
  }
  return tris;
}

function parseAsciiStl(text: string): Triangle[] {
  const tris: Triangle[] = [];
  const vertexRe = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  const verts: Vec3[] = [];
  let m: RegExpExecArray | null;
  while ((m = vertexRe.exec(text)) !== null) {
    const x = Number(m[1]);
    const y = Number(m[2]);
    const z = Number(m[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new StlParseError("STL contains a non-numeric vertex");
    }
    verts.push({ x, y, z });
  }
  if (verts.length % 3 !== 0) {
    throw new StlParseError(`STL has ${verts.length} vertices, which is not a whole number of triangles`);
  }
  for (let i = 0; i < verts.length; i += 3) {
    tris.push({ a: verts[i]!, b: verts[i + 1]!, c: verts[i + 2]! });
  }
  return tris;
}

function key(v: Vec3): string {
  // Snap to the epsilon grid so float noise does not split a shared vertex.
  const q = (n: number) => Math.round(n / EPSILON);
  return `${q(v.x)},${q(v.y)},${q(v.z)}`;
}

function cross(u: Vec3, v: Vec3): Vec3 {
  return {
    x: u.y * v.z - u.z * v.y,
    y: u.z * v.x - u.x * v.z,
    z: u.x * v.y - u.y * v.x,
  };
}

function sub(u: Vec3, v: Vec3): Vec3 {
  return { x: u.x - v.x, y: u.y - v.y, z: u.z - v.z };
}

function dot(u: Vec3, v: Vec3): number {
  return u.x * v.x + u.y * v.y + u.z * v.z;
}

const EMPTY_BOX: BoundingBox = { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };

export function measure(tris: Triangle[]): MeshMetrics {
  if (tris.length === 0) {
    return {
      triangleCount: 0,
      vertexCount: 0,
      boundingBox: EMPTY_BOX,
      volumeMm3: 0,
      surfaceAreaMm2: 0,
      watertight: false,
      openEdgeCount: 0,
      nonManifoldEdgeCount: 0,
      degenerateTriangleCount: 0,
      solid: false,
    };
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let volume6 = 0;
  let area2 = 0;
  let degenerate = 0;

  const vertices = new Set<string>();
  /** Undirected edge -> how many triangles use it. */
  const edgeUse = new Map<string, number>();

  const touchEdge = (p: Vec3, q: Vec3) => {
    const kp = key(p);
    const kq = key(q);
    const e = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
    edgeUse.set(e, (edgeUse.get(e) ?? 0) + 1);
  };

  for (const t of tris) {
    for (const v of [t.a, t.b, t.c]) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.z < minZ) minZ = v.z;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
      if (v.z > maxZ) maxZ = v.z;
      vertices.add(key(v));
    }

    // Signed volume of the tetrahedron formed with the origin.
    volume6 += dot(t.a, cross(t.b, t.c));

    const n = cross(sub(t.b, t.a), sub(t.c, t.a));
    const twiceArea = Math.hypot(n.x, n.y, n.z);
    area2 += twiceArea;
    if (twiceArea <= Number.EPSILON) degenerate++;

    touchEdge(t.a, t.b);
    touchEdge(t.b, t.c);
    touchEdge(t.c, t.a);
  }

  let openEdges = 0;
  let nonManifold = 0;
  for (const used of edgeUse.values()) {
    if (used === 1) openEdges++;
    else if (used > 2) nonManifold++;
  }

  const volumeMm3 = volume6 / 6;
  const watertight = openEdges === 0 && nonManifold === 0;

  return {
    triangleCount: tris.length,
    vertexCount: vertices.size,
    boundingBox: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      size: [maxX - minX, maxY - minY, maxZ - minZ],
    },
    volumeMm3,
    surfaceAreaMm2: area2 / 2,
    watertight,
    openEdgeCount: openEdges,
    nonManifoldEdgeCount: nonManifold,
    degenerateTriangleCount: degenerate,
    solid: watertight && volumeMm3 > 0,
  };
}

/** Common filament and resin densities in g/cm3, for the mass estimate. */
export const MATERIAL_DENSITY: Record<string, number> = {
  PLA: 1.24,
  PETG: 1.27,
  ABS: 1.04,
  ASA: 1.07,
  TPU: 1.21,
  NYLON: 1.14,
  "PLA-CF": 1.3,
  "PETG-CF": 1.3,
  RESIN: 1.12,
};

/**
 * Estimated mass of the solid part. Real prints are not solid, so this is an
 * upper bound and should be labelled as one wherever it is shown.
 */
export function estimateMassGrams(volumeMm3: number, material: string): number | null {
  const density = MATERIAL_DENSITY[material.toUpperCase()];
  if (density === undefined) return null;
  return (volumeMm3 / 1000) * density;
}
