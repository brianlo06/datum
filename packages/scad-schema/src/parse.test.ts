import { describe, expect, it } from "vitest";
import { parseScad } from "./parse.js";
import type { Param } from "./types.js";

function byName(params: Param[], name: string): Param {
  const found = params.find((p) => p.name === name);
  if (!found) throw new Error(`no parameter named ${name}; got ${params.map((p) => p.name).join(", ")}`);
  return found;
}

describe("parseScad", () => {
  it("extracts a plain numeric parameter with its description", () => {
    const { params } = parseScad(["// Thickness of the wall", "wall = 2.4;"].join("\n"));
    expect(params).toHaveLength(1);
    const wall = params[0]!;
    expect(wall.name).toBe("wall");
    expect(wall.type).toBe("number");
    expect(wall.default).toBe(2.4);
    expect(wall.description).toBe("Thickness of the wall");
    expect(wall.widget).toEqual({ kind: "spinbox" });
    expect(wall.group).toBe("Parameters");
    expect(wall.line).toBe(2);
  });

  it("reads a two-value range as an integer slider when everything is integral", () => {
    const { params } = parseScad("count = 4; // [1:12]");
    expect(byName(params, "count").widget).toEqual({ kind: "slider", min: 1, max: 12, step: 1 });
  });

  it("infers a fractional step when the range is not integral", () => {
    const { params } = parseScad("bolt = 3.5; // [3:8]");
    const w = byName(params, "bolt").widget;
    expect(w.kind).toBe("slider");
    if (w.kind !== "slider") throw new Error("expected slider");
    expect(w.min).toBe(3);
    expect(w.max).toBe(8);
    expect(w.step).toBeLessThan(1);
    expect(w.step).toBeGreaterThan(0);
  });

  it("reads an explicit min:step:max range", () => {
    const { params } = parseScad("bolt_d = 3; // [3:0.5:8]");
    expect(byName(params, "bolt_d").widget).toEqual({ kind: "slider", min: 3, max: 8, step: 0.5 });
  });

  it("reads an unlabelled dropdown", () => {
    const { params } = parseScad('material = "PETG"; // [PLA, PETG, ASA]');
    expect(byName(params, "material").widget).toEqual({
      kind: "select",
      options: [
        { value: "PLA", label: "PLA" },
        { value: "PETG", label: "PETG" },
        { value: "ASA", label: "ASA" },
      ],
    });
  });

  it("reads a labelled dropdown and keeps numeric values numeric", () => {
    const { params } = parseScad("nozzle = 4; // [4:0.4mm, 6:0.6mm, 8:0.8mm]");
    const w = byName(params, "nozzle").widget;
    if (w.kind !== "select") throw new Error("expected select");
    expect(w.options).toEqual([
      { value: 4, label: "0.4mm" },
      { value: 6, label: "0.6mm" },
      { value: 8, label: "0.8mm" },
    ]);
  });

  it("treats booleans as checkboxes", () => {
    const { params } = parseScad("with_lid = true;");
    const lid = byName(params, "with_lid");
    expect(lid.type).toBe("boolean");
    expect(lid.default).toBe(true);
    expect(lid.widget).toEqual({ kind: "checkbox" });
  });

  it("reads a string max length annotation", () => {
    const { params } = parseScad('label = "front"; // 16');
    expect(byName(params, "label").widget).toEqual({ kind: "text", maxLength: 16 });
  });

  it("handles vectors, including a shared component range", () => {
    const { params } = parseScad("size = [42, 42, 20]; // [10:200]");
    const size = byName(params, "size");
    expect(size.type).toBe("vector");
    expect(size.default).toEqual([42, 42, 20]);
    expect(size.widget).toEqual({ kind: "vector", length: 3, min: 10, max: 200, step: 2 });
  });

  it("assigns parameters to groups and records group order", () => {
    const source = [
      "/* [Fasteners] */",
      "bolt = 3;",
      "/* [Appearance] */",
      "// Rounding radius",
      "fillet = 1;",
    ].join("\n");
    const { params, groups } = parseScad(source);
    expect(groups).toEqual(["Fasteners", "Appearance"]);
    expect(byName(params, "bolt").group).toBe("Fasteners");
    expect(byName(params, "fillet").group).toBe("Appearance");
    expect(byName(params, "fillet").description).toBe("Rounding radius");
  });

  it("marks parameters after a Hidden marker as hidden but still assignable", () => {
    const source = ["visible = 1;", "/* [Hidden] */", "internal_tweak = 0.2;"].join("\n");
    const { params, hidden } = parseScad(source);
    expect(hidden).toEqual(["internal_tweak"]);
    expect(params.map((p) => p.name)).toEqual(["visible", "internal_tweak"]);
    expect(byName(params, "internal_tweak").group).toBe("Hidden");
  });

  it("stops at the first module definition", () => {
    const source = ["outer = 10;", "module thing() {", "  inner = 5;", "}", "after = 3;"].join("\n");
    const { params } = parseScad(source);
    expect(params.map((p) => p.name)).toEqual(["outer"]);
  });

  it("ignores special variables like $fn", () => {
    const { params } = parseScad(["$fn = 64;", "d = 10;"].join("\n"));
    expect(params.map((p) => p.name)).toEqual(["d"]);
  });

  it("skips expression-valued assignments and warns if they were annotated", () => {
    const source = ["radius = 5;", "diameter = radius * 2; // [1:100]"].join("\n");
    const { params, warnings } = parseScad(source);
    expect(params.map((p) => p.name)).toEqual(["radius"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("cannot be configured");
  });

  it("handles a statement spanning several lines", () => {
    const source = ["offsets = [", "  1, 2,", "  3", "]; // [0:10]"].join("\n");
    const { params } = parseScad(source);
    const p = byName(params, "offsets");
    expect(p.default).toEqual([1, 2, 3]);
    expect(p.widget).toEqual({ kind: "vector", length: 3, min: 0, max: 10, step: 0.1 });
  });

  it("does not mistake a double slash inside a string for a comment", () => {
    const { params } = parseScad('url = "https://example.com/part"; // 80');
    const p = byName(params, "url");
    expect(p.default).toBe("https://example.com/part");
    expect(p.widget).toEqual({ kind: "text", maxLength: 80 });
  });

  it("ignores include and use directives", () => {
    const source = ["include <BOSL2/std.scad>", "use <helpers.scad>", "w = 5;"].join("\n");
    const { params } = parseScad(source);
    expect(params.map((p) => p.name)).toEqual(["w"]);
  });

  it("skips non-group block comments without swallowing later parameters", () => {
    const source = ["/*", " * A licence header.", " */", "w = 5;"].join("\n");
    expect(parseScad(source).params.map((p) => p.name)).toEqual(["w"]);
  });

  it("uses only the last comment line, so a file header is not swallowed", () => {
    const source = [
      "// A parametric spacer",
      "// Outer diameter",
      "outer_d = 20; // [8:60]",
    ].join("\n");
    expect(byName(parseScad(source).params, "outer_d").description).toBe("Outer diameter");
  });

  it("clears a description when a blank line separates it from the assignment", () => {
    const source = ["// A stray note", "", "w = 5;"].join("\n");
    expect(byName(parseScad(source).params, "w").description).toBeUndefined();
  });

  it("warns about a reversed range instead of producing a broken slider", () => {
    const { params, warnings } = parseScad("w = 5; // [10:1]");
    expect(byName(params, "w").widget).toEqual({ kind: "spinbox" });
    expect(warnings[0]!.message).toContain("below min");
  });

  it("warns about an unrecognised annotation and falls back to a plain widget", () => {
    const { params, warnings } = parseScad("w = 5; // whatever this is");
    expect(byName(params, "w").widget).toEqual({ kind: "spinbox" });
    expect(warnings[0]!.message).toContain("unrecognised annotation");
  });

  it("parses a realistic part header end to end", () => {
    const source = [
      "// Gridfinity-compatible bin",
      "include <gridfinity.scad>",
      "",
      "/* [Grid] */",
      "// Width in grid units",
      "grid_x = 2; // [1:1:6]",
      "// Depth in grid units",
      "grid_y = 1; // [1:1:6]",
      "// Height in 7mm units",
      "grid_z = 6; // [2:1:24]",
      "",
      "/* [Features] */",
      "// Include the magnet holes",
      "magnets = true;",
      "// Label style",
      "label = 1; // [0:None, 1:Tab, 2:Full width]",
      "",
      "/* [Hidden] */",
      "tolerance = 0.25;",
      "",
      "module bin() { cube(1); }",
    ].join("\n");

    const schema = parseScad(source);
    expect(schema.warnings).toEqual([]);
    expect(schema.groups).toEqual(["Grid", "Features"]);
    expect(schema.hidden).toEqual(["tolerance"]);
    expect(schema.params.map((p) => p.name)).toEqual([
      "grid_x",
      "grid_y",
      "grid_z",
      "magnets",
      "label",
      "tolerance",
    ]);
    expect(byName(schema.params, "grid_x").widget).toEqual({
      kind: "slider",
      min: 1,
      max: 6,
      step: 1,
    });
    expect(byName(schema.params, "grid_z").description).toBe("Height in 7mm units");
    const labelWidget = byName(schema.params, "label").widget;
    if (labelWidget.kind !== "select") throw new Error("expected select");
    expect(labelWidget.options.map((o) => o.label)).toEqual(["None", "Tab", "Full width"]);
  });
});
