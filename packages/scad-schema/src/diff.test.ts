import { describe, expect, it } from "vitest";
import { diffSchemas } from "./diff.js";
import { parseScad } from "./parse.js";

const s = (...lines: string[]) => parseScad(lines.join("\n"));

describe("diffSchemas", () => {
  it("reports an identical schema as identical", () => {
    const a = s("// Wall", "wall = 2; // [1:5]");
    const d = diffSchemas(a, s("// Wall", "wall = 2; // [1:5]"));
    expect(d.identical).toBe(true);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
  });

  it("detects an added parameter", () => {
    const d = diffSchemas(s("wall = 2;"), s("wall = 2;", "lid = true;"));
    expect(d.added).toEqual(["lid"]);
    expect(d.removed).toEqual([]);
    expect(d.identical).toBe(false);
  });

  it("detects a removed parameter", () => {
    const d = diffSchemas(s("wall = 2;", "lid = true;"), s("wall = 2;"));
    expect(d.removed).toEqual(["lid"]);
  });

  it("treats a type change as breaking and stops comparing further", () => {
    const d = diffSchemas(s("mode = 1;"), s('mode = "fast";'));
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]).toMatchObject({ name: "mode", kind: "type", severity: "breaking" });
  });

  it("treats a narrowed range as breaking", () => {
    const d = diffSchemas(s("w = 5; // [1:10]"), s("w = 5; // [2:8]"));
    const change = d.changed.find((c) => c.kind === "range");
    expect(change).toMatchObject({ severity: "breaking", from: "1..10", to: "2..8" });
    expect(change!.detail).toContain("may now be rejected");
  });

  it("treats a widened range as additive", () => {
    const d = diffSchemas(s("w = 5; // [2:8]"), s("w = 5; // [1:10]"));
    expect(d.changed.find((c) => c.kind === "range")).toMatchObject({ severity: "additive" });
  });

  it("ignores a step-only change as neither narrowing nor widening", () => {
    const d = diffSchemas(s("w = 5; // [1:1:10]"), s("w = 5; // [1:0.5:10]"));
    expect(d.changed.filter((c) => c.kind === "range")).toEqual([]);
  });

  it("treats a removed dropdown option as breaking", () => {
    const d = diffSchemas(
      s('m = "PLA"; // [PLA, PETG, ASA]'),
      s('m = "PLA"; // [PLA, PETG]'),
    );
    const change = d.changed.find((c) => c.kind === "options");
    expect(change).toMatchObject({ severity: "breaking" });
    expect(change!.detail).toContain("ASA");
  });

  it("treats an added dropdown option as additive", () => {
    const d = diffSchemas(
      s('m = "PLA"; // [PLA, PETG]'),
      s('m = "PLA"; // [PLA, PETG, ASA]'),
    );
    expect(d.changed.find((c) => c.kind === "options")).toMatchObject({ severity: "additive" });
  });

  it("flags a changed default, because it silently changes the part for most users", () => {
    const d = diffSchemas(s("w = 2;"), s("w = 3;"));
    const change = d.changed.find((c) => c.kind === "default");
    expect(change).toMatchObject({ severity: "additive", from: "2", to: "3" });
    expect(change!.detail).toContain("different part");
  });

  it("treats a group move as cosmetic", () => {
    const d = diffSchemas(
      s("/* [A] */", "w = 2;"),
      s("/* [B] */", "w = 2;"),
    );
    expect(d.changed).toEqual([
      expect.objectContaining({ kind: "group", severity: "cosmetic", from: "A", to: "B" }),
    ]);
  });

  it("flags newly constraining a previously unbounded parameter", () => {
    const d = diffSchemas(s("w = 5;"), s("w = 5; // [1:10]"));
    expect(d.changed.find((c) => c.kind === "widget")).toMatchObject({ severity: "additive" });
  });

  it("flags removing a constraint as breaking in the other direction", () => {
    const d = diffSchemas(s("w = 5; // [1:10]"), s("w = 5;"));
    expect(d.changed.find((c) => c.kind === "widget")).toMatchObject({ severity: "breaking" });
  });

  it("handles a realistic multi-change revision", () => {
    const prev = s(
      "/* [Body] */",
      "arm = 40; // [20:5:80]",
      "thickness = 5; // [3:0.5:10]",
      "legacy = 1;",
    );
    const next = s(
      "/* [Body] */",
      "arm = 40; // [20:5:100]",
      "thickness = 6; // [3:0.5:10]",
      "/* [New] */",
      "fillet = 1; // [0:3]",
    );
    const d = diffSchemas(prev, next);
    expect(d.added).toEqual(["fillet"]);
    expect(d.removed).toEqual(["legacy"]);
    expect(d.changed.map((c) => `${c.name}:${c.kind}`).sort()).toEqual([
      "arm:range",
      "thickness:default",
    ]);
  });
});
