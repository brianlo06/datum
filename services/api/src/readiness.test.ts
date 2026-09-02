import { describe, expect, it } from "vitest";
import { parseScad } from "@datum/scad-schema";
import { evaluateReadiness, type BuildOutcome } from "./readiness.js";
import type { MeshMetricsLike } from "./types.js";

const metrics = (over: Partial<MeshMetricsLike> = {}): MeshMetricsLike => ({
  triangleCount: 660,
  boundingBox: { size: [40, 20, 40] },
  volumeMm3: 7454,
  solid: true,
  openEdgeCount: 0,
  nonManifoldEdgeCount: 0,
  ...over,
});

const good: BuildOutcome = { ok: true, summary: "Build succeeded.", metrics: metrics() };

const GOOD_SOURCE = [
  "/* [Body] */",
  "// Length of each arm",
  "arm = 40; // [20:5:80]",
  "// Wall thickness",
  "wall = 5; // [3:0.5:10]",
].join("\n");

const check = (schema: string, build: BuildOutcome, id: string) => {
  const r = evaluateReadiness(parseScad(schema), build);
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
};

describe("evaluateReadiness", () => {
  it("passes a well-formed part with no blockers", () => {
    const r = evaluateReadiness(parseScad(GOOD_SOURCE), good);
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("blocks a part that does not build, and quotes the reason", () => {
    const r = evaluateReadiness(parseScad(GOOD_SOURCE), {
      ok: false,
      summary: "The source could not be parsed, so nothing was built.",
      metrics: null,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers).toEqual(["Compiles to geometry"]);
    expect(check(GOOD_SOURCE, { ok: false, summary: "nope", metrics: null }, "builds").detail).toBe("nope");
  });

  it("blocks a part with no configurable parameters", () => {
    const r = evaluateReadiness(parseScad("module thing() { cube(10); }\nthing();"), good);
    expect(r.ready).toBe(false);
    expect(r.blockers).toEqual(["Has configurable parameters"]);
    expect(r.checks.find((c) => c.id === "parametric")!.detail).toContain("fixed model");
  });

  it("does not count hidden parameters towards being parametric", () => {
    const r = evaluateReadiness(parseScad("/* [Hidden] */\neps = 0.01;"), good);
    expect(r.ready).toBe(false);
    expect(r.blockers).toContain("Has configurable parameters");
  });

  it("warns but does not block when the mesh is not a closed solid", () => {
    const r = evaluateReadiness(parseScad(GOOD_SOURCE), {
      ...good,
      metrics: metrics({ solid: false, openEdgeCount: 12 }),
    });
    expect(r.ready).toBe(true);
    const solid = r.checks.find((c) => c.id === "solid")!;
    expect(solid.status).toBe("warn");
    expect(solid.blocking).toBe(false);
    expect(solid.detail).toContain("12 open edges");
  });

  it("warns about undocumented parameters and names them", () => {
    const c = check("arm = 40; // [1:80]\nwall = 5; // [1:10]", good, "documented");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("arm, wall");
  });

  it("truncates a long list of undocumented parameters", () => {
    const src = Array.from({ length: 8 }, (_, i) => `p${i} = 1; // [0:10]`).join("\n");
    const c = check(src, good, "documented");
    expect(c.detail).toContain("…");
    expect(c.detail).toContain("8 parameters have");
  });

  it("warns about numeric parameters with no range", () => {
    const c = check("// Wall\nwall = 5;", good, "bounded");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("wall");
  });

  it("does not ask for a range on booleans or strings", () => {
    const c = check('// A\na = true;\n// B\nb = "x";', good, "bounded");
    expect(c.status).toBe("pass");
  });

  it("surfaces schema warnings", () => {
    const c = check("// W\nw = 5; // nonsense annotation", good, "clean-schema");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("line 2");
  });

  it("catches a part modelled in metres", () => {
    const c = check(GOOD_SOURCE, { ...good, metrics: metrics({ boundingBox: { size: [0.04, 0.02, 0.04] } }) }, "plausible-size");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("drawn in metres");
  });

  it("catches a part far too big for any machine", () => {
    const c = check(GOOD_SOURCE, { ...good, metrics: metrics({ boundingBox: { size: [4000, 20, 40] } }) }, "plausible-size");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("4.00 m across");
  });

  it("accepts a small but plausible part", () => {
    const c = check(GOOD_SOURCE, { ...good, metrics: metrics({ boundingBox: { size: [3, 3, 1] } }) }, "plausible-size");
    expect(c.status).toBe("pass");
  });

  it("marks geometry checks as not-checked rather than failed when the build failed", () => {
    const failed: BuildOutcome = { ok: false, summary: "boom", metrics: null };
    expect(check(GOOD_SOURCE, failed, "solid").detail).toContain("Not checked");
    expect(check(GOOD_SOURCE, failed, "plausible-size").detail).toContain("Not checked");
  });

  it("reports every blocker at once rather than stopping at the first", () => {
    const r = evaluateReadiness(parseScad("module m() { cube(1); }"), {
      ok: false,
      summary: "boom",
      metrics: null,
    });
    expect(r.blockers).toEqual(["Compiles to geometry", "Has configurable parameters"]);
  });
});
