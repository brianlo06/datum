import { describe, expect, it } from "vitest";
import { parseScad } from "./parse.js";
import { applySuggestions, suggestAnnotations } from "./suggest.js";

const s = (...lines: string[]) => lines.join("\n");
const suggestFor = (source: string) => suggestAnnotations(parseScad(source));
const one = (source: string) => {
  const all = suggestFor(source);
  if (all.length !== 1) throw new Error(`expected 1 suggestion, got ${all.length}`);
  return all[0]!;
};

describe("suggestAnnotations", () => {
  it("leaves already-annotated parameters alone", () => {
    expect(suggestFor("w = 5; // [1:10]")).toEqual([]);
    expect(suggestFor('m = "PLA"; // [PLA, PETG]')).toEqual([]);
  });

  it("ignores booleans, strings and vectors", () => {
    expect(suggestFor(s("lid = true;", 'label = "x";', "size = [1,2,3];"))).toEqual([]);
  });

  it("ignores hidden parameters", () => {
    expect(suggestFor(s("/* [Hidden] */", "eps = 0.01;"))).toEqual([]);
  });

  it("recognises a wall thickness", () => {
    const sug = one("wall = 2.4;");
    expect(sug.widget).toMatchObject({ kind: "slider", min: 0.4 });
    expect(sug.confidence).toBe("high");
    expect(sug.rationale).toContain("extrusion width");
  });

  it("recognises a fastener diameter", () => {
    const sug = one("bolt_d = 5;");
    expect(sug.widget).toEqual({ kind: "slider", min: 2, max: 12, step: 0.5 });
    expect(sug.annotation).toBe("// [2:0.5:12]");
  });

  it("recognises a count and keeps it integral", () => {
    const sug = one("holes = 3;");
    expect(sug.widget).toMatchObject({ kind: "slider", min: 1, step: 1 });
  });

  it("recognises an angle as a full rotation", () => {
    expect(one("angle = 30;").widget).toEqual({ kind: "slider", min: 0, max: 360, step: 5 });
  });

  it("recognises a clearance as sub-millimetre", () => {
    expect(one("tolerance = 0.2;").widget).toEqual({ kind: "slider", min: 0, max: 1, step: 0.05 });
  });

  it("falls back to bracketing the default, with low confidence", () => {
    const sug = one("splorp = 8;");
    expect(sug.confidence).toBe("low");
    expect(sug.widget).toMatchObject({ kind: "slider", min: 2, max: 32 });
    expect(sug.rationale).toContain("default of 8");
  });

  it("never proposes a range that would reject the author's own default", () => {
    // A clearance rule caps at 1, but this author's default is 3.
    const sug = one("tolerance = 3;");
    if (sug.widget.kind !== "slider") throw new Error("expected slider");
    expect(sug.widget.min).toBeLessThanOrEqual(3);
    expect(sug.widget.max).toBeGreaterThanOrEqual(3);
  });

  it("declines to guess for a negative default", () => {
    expect(suggestFor("offset_z = -2;")).toEqual([]);
  });

  it("handles a zero default without proposing a degenerate range", () => {
    const sug = one("fillet = 0;");
    if (sug.widget.kind !== "slider") throw new Error("expected slider");
    expect(sug.widget.max).toBeGreaterThan(sug.widget.min);
  });

  it("produces an annotation that round-trips through the parser", () => {
    const source = "// Bolt diameter\nbolt_d = 5;";
    const { source: updated } = applySuggestions(source, parseScad(source), suggestFor(source));
    const reparsed = parseScad(updated);
    expect(reparsed.warnings).toEqual([]);
    expect(reparsed.params[0]!.widget).toEqual({ kind: "slider", min: 2, max: 12, step: 0.5 });
    expect(reparsed.params[0]!.default).toBe(5);
    expect(reparsed.params[0]!.description).toBe("Bolt diameter");
  });

  it("suggests for a realistic wall of bare assignments", () => {
    const source = s(
      "/* [Size] */",
      "arm = 40;",
      "thickness = 5;",
      "width = 20;",
      "bolt_d = 5;",
      "holes = 1;",
      "gusset = true;",
    );
    const suggestions = suggestFor(source);
    expect(suggestions.map((x) => x.param)).toEqual([
      "arm",
      "thickness",
      "width",
      "bolt_d",
      "holes",
    ]);
    expect(suggestions.filter((x) => x.confidence === "high").length).toBeGreaterThanOrEqual(4);
  });
});

describe("applySuggestions", () => {
  it("appends the annotation to the right line and leaves the rest untouched", () => {
    const source = s("// Bolt diameter", "bolt_d = 5;", "", "module x() { cube(1); }");
    const schema = parseScad(source);
    const { source: updated, applied } = applySuggestions(source, schema, suggestAnnotations(schema));
    expect(applied).toEqual(["bolt_d"]);
    expect(updated.split("\n")).toEqual([
      "// Bolt diameter",
      "bolt_d = 5; // [2:0.5:12]",
      "",
      "module x() { cube(1); }",
    ]);
  });

  it("applies several suggestions without line numbers drifting", () => {
    const source = s("a_wall = 2;", "b_angle = 10;", "c_holes = 2;");
    const schema = parseScad(source);
    const { source: updated, applied } = applySuggestions(source, schema, suggestAnnotations(schema));
    expect(applied).toEqual(["a_wall", "b_angle", "c_holes"]);
    for (const line of updated.split("\n")) expect(line).toMatch(/\/\/ \[/);
    expect(parseScad(updated).warnings).toEqual([]);
  });

  it("skips a line that already carries a comment rather than mangling it", () => {
    const source = "wall = 2; // set by hand";
    const schema = parseScad(source);
    // Force a suggestion even though the parser saw a trailing comment.
    const forced = [
      { param: "wall", widget: { kind: "slider" as const, min: 1, max: 5, step: 0.5 }, rationale: "", confidence: "low" as const, annotation: "// [1:0.5:5]" },
    ];
    const { source: updated, applied, skipped } = applySuggestions(source, schema, forced);
    expect(applied).toEqual([]);
    expect(skipped).toEqual(["wall"]);
    expect(updated).toBe(source);
  });

  it("skips a parameter that is not in the schema", () => {
    const source = "wall = 2;";
    const schema = parseScad(source);
    const { skipped } = applySuggestions(source, schema, [
      { param: "nope", widget: { kind: "spinbox" }, rationale: "", confidence: "low", annotation: "// [1:2]" },
    ]);
    expect(skipped).toEqual(["nope"]);
  });

  it("preserves the author's indentation and trailing structure", () => {
    const source = s("thing = 3;", "cube(thing);");
    const schema = parseScad(source);
    const { source: updated } = applySuggestions(source, schema, suggestAnnotations(schema));
    expect(updated.endsWith("cube(thing);")).toBe(true);
  });

  it("is a no-op when nothing is accepted", () => {
    const source = "wall = 2;";
    const { source: updated, applied } = applySuggestions(source, parseScad(source), []);
    expect(updated).toBe(source);
    expect(applied).toEqual([]);
  });
});
