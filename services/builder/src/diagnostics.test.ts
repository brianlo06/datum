import { describe, expect, it } from "vitest";
import { parseDiagnostics, summarize } from "./diagnostics.js";

describe("parseDiagnostics", () => {
  it("extracts level, message and location", () => {
    const out = parseDiagnostics(
      "ERROR: Parser error: syntax error in file main.scad, line 12",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.level).toBe("error");
    expect(out[0]!.file).toBe("main.scad");
    expect(out[0]!.line).toBe(12);
    expect(out[0]!.explanation).toContain("could not be parsed");
    expect(out[0]!.hint).toContain("semicolon");
  });

  it("classifies warnings separately from errors", () => {
    const out = parseDiagnostics("WARNING: Ignoring unknown variable 'wdith' in file main.scad, line 4");
    expect(out[0]!.level).toBe("warning");
    expect(out[0]!.explanation).toContain("name that does not exist");
  });

  it("drops TRACE and INFO noise", () => {
    const out = parseDiagnostics(
      ["TRACE: called by 'bracket'", "INFO: Compiling design", "WARNING: something odd"].join("\n"),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.raw).toBe("something odd");
  });

  it("keeps unrecognised messages verbatim without inventing an explanation", () => {
    const out = parseDiagnostics("WARNING: some future message we do not know about");
    expect(out[0]!.raw).toBe("some future message we do not know about");
    expect(out[0]!.explanation).toBeUndefined();
  });

  it("recognises an empty top-level object", () => {
    const out = parseDiagnostics("WARNING: Current top level object is empty.");
    expect(out[0]!.explanation).toContain("no geometry");
  });

  it("recognises a non-manifold result", () => {
    const out = parseDiagnostics("WARNING: Object may not be a valid 2-manifold and may need repair!");
    expect(out[0]!.explanation).toContain("self-intersections");
  });

  it("recognises a failed assertion", () => {
    const out = parseDiagnostics('ERROR: Assertion \'wall > 0\' failed in file main.scad, line 9');
    expect(out[0]!.explanation).toContain("rejected these parameter values");
  });

  it("recognises a missing include and explains the isolation rule", () => {
    const out = parseDiagnostics("WARNING: Can't open input file 'BOSL2/std.scad'.");
    expect(out[0]!.hint).toContain("published with the part");
  });

  it("handles empty and whitespace-only stderr", () => {
    expect(parseDiagnostics("")).toEqual([]);
    expect(parseDiagnostics("   \n\n  ")).toEqual([]);
  });

  it("ignores lines that are not diagnostics at all", () => {
    expect(parseDiagnostics("Geometries in cache: 12\nCSG generation finished.")).toEqual([]);
  });
});

describe("summarize", () => {
  it("prefers the first error over any warning", () => {
    const diags = parseDiagnostics(
      ["WARNING: Current top level object is empty.", "ERROR: Parser error: syntax error"].join("\n"),
    );
    expect(summarize(diags, "fallback")).toContain("could not be parsed");
  });

  it("uses an explained warning when there is no error", () => {
    const diags = parseDiagnostics("WARNING: Current top level object is empty.");
    expect(summarize(diags, "fallback")).toContain("no geometry");
  });

  it("falls back when nothing is recognised", () => {
    expect(summarize([], "OpenSCAD exited with status 1")).toBe("OpenSCAD exited with status 1");
  });
});
