import { describe, expect, it } from "vitest";
import { classify } from "./classify.js";

const src = (...lines: string[]) => lines.join("\n");

describe("classify", () => {
  it("recognises a pure library as having no top-level geometry", () => {
    const c = classify(
      src(
        "module block(s) { cube([s, s, s]); }",
        "function double(x) = x * 2;",
        "module tube(d, h) { cylinder(d = d, h = h); }",
      ),
    );
    expect(c.hasTopLevelGeometry).toBe(false);
    expect(c.moduleCount).toBe(2);
    expect(c.functionCount).toBe(1);
    expect(c.topLevelCalls).toEqual([]);
  });

  it("recognises a part that instantiates a module", () => {
    const c = classify(src("module block(s) { cube([s, s, s]); }", "block(10);"));
    expect(c.hasTopLevelGeometry).toBe(true);
    expect(c.topLevelCalls).toEqual(["block"]);
  });

  it("recognises a bare primitive at the top level", () => {
    expect(classify("cube([10, 10, 10]);").topLevelCalls).toEqual(["cube"]);
  });

  it("recognises a transform chain", () => {
    const c = classify("translate([0, 0, 5]) rotate([90, 0, 0]) cylinder(d = 4, h = 9);");
    expect(c.hasTopLevelGeometry).toBe(true);
    expect(c.topLevelCalls[0]).toBe("translate");
  });

  it("counts top-level control flow as geometry", () => {
    expect(classify("for (i = [0:3]) cube(i);").hasTopLevelGeometry).toBe(true);
    expect(classify("if (true) sphere(4);").hasTopLevelGeometry).toBe(true);
  });

  it("does not count echo or assert as geometry", () => {
    const c = classify(src('echo("hello");', "assert(1 == 1);"));
    expect(c.hasTopLevelGeometry).toBe(false);
  });

  it("does not count a function call on the right of an assignment", () => {
    const c = classify(src("function double(x) = x * 2;", "size = double(5);"));
    expect(c.hasTopLevelGeometry).toBe(false);
  });

  it("does not count calls inside a module body", () => {
    const c = classify(
      src("module thing() {", "  cube(10);", "  translate([1,0,0]) sphere(2);", "}"),
    );
    expect(c.hasTopLevelGeometry).toBe(false);
  });

  it("does not count calls inside a function body", () => {
    const c = classify("function area(r) = PI * pow(r, 2);");
    expect(c.hasTopLevelGeometry).toBe(false);
  });

  it("finds geometry that follows a module definition", () => {
    const c = classify(
      src("module a() { cube(1); }", "module b() { sphere(1); }", "a();", "b();"),
    );
    expect(c.topLevelCalls).toEqual(["a", "b"]);
  });

  it("ignores calls that appear only inside comments", () => {
    const c = classify(
      src("// cube(10);", "/* translate([0,0,0]) sphere(5); */", "module x() { cube(1); }"),
    );
    expect(c.hasTopLevelGeometry).toBe(false);
  });

  it("ignores calls that appear only inside strings", () => {
    expect(classify('label = "cube(10);";').hasTopLevelGeometry).toBe(false);
  });

  it("collects include and use targets", () => {
    const c = classify(
      src("include <BOSL2/std.scad>", "use <../lib/helpers.scad>", "cube(1);"),
    );
    expect(c.includes).toEqual(["BOSL2/std.scad", "../lib/helpers.scad"]);
  });

  it("does not treat the include target as a call", () => {
    const c = classify("include <shapes.scad>");
    expect(c.hasTopLevelGeometry).toBe(false);
  });

  it("handles an unterminated block comment without hanging", () => {
    expect(classify("/* never closed\ncube(10);").hasTopLevelGeometry).toBe(false);
  });

  it("handles a realistic part file", () => {
    const c = classify(
      src(
        "// A bracket",
        "include <lib/util.scad>",
        "",
        "/* [Size] */",
        "arm = 40; // [20:80]",
        "",
        "module bracket(a) {",
        "  difference() {",
        "    cube([a, 20, 5]);",
        "    cylinder(d = 5, h = 20);",
        "  }",
        "}",
        "",
        "bracket(arm);",
      ),
    );
    expect(c.hasTopLevelGeometry).toBe(true);
    expect(c.topLevelCalls).toEqual(["bracket"]);
    expect(c.moduleCount).toBe(1);
    expect(c.includes).toEqual(["lib/util.scad"]);
  });
});
