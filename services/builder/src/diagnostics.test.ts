import { describe, expect, it } from "vitest";
import { findIncompleteness, parseDiagnostics, summarize } from "./diagnostics.js";

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
    // OpenSCAD's wording differs between the entry file, include <> and use <>.
    for (const raw of [
      "WARNING: Can't open input file 'NopSCADlib/lib.scad'.",
      "WARNING: Can't open include file 'NopSCADlib/lib.scad'.",
      "WARNING: Can't open library 'NopSCADlib/lib.scad'.",
    ]) {
      const out = parseDiagnostics(raw);
      expect(out[0]!.explanation).toContain("could not be found");
      expect(out[0]!.hint).toContain("published with the part");
    }
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

describe("findIncompleteness", () => {
  it("flags a missing include, which silently drops whatever it defined", () => {
    const reasons = findIncompleteness(
      parseDiagnostics("WARNING: Can't open include file 'shapes.scad'."),
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('"shapes.scad"');
    expect(reasons[0]).toContain("could not be found");
  });

  it("flags an unknown module, which drops everything it would have drawn", () => {
    const reasons = findIncompleteness(
      parseDiagnostics("WARNING: Ignoring unknown module 'blk' in file demo.scad, line 3"),
    );
    expect(reasons[0]).toContain('"blk"');
    expect(reasons[0]).toContain("missing");
  });

  it("covers each phrasing OpenSCAD uses for an unopenable file", () => {
    for (const raw of [
      "WARNING: Can't open input file 'a.scad'.",
      "WARNING: Can't open include file 'a.scad'.",
      "WARNING: Can't open library 'a.scad'.",
    ]) {
      expect(findIncompleteness(parseDiagnostics(raw))).toHaveLength(1);
    }
  });

  it("does not flag an unknown variable, which changes values rather than dropping geometry", () => {
    expect(
      findIncompleteness(parseDiagnostics("WARNING: Ignoring unknown variable 'wdith'")),
    ).toEqual([]);
  });

  it("does not flag a manifold warning, which is a quality signal not an omission", () => {
    expect(
      findIncompleteness(parseDiagnostics("WARNING: Object may not be a valid 2-manifold")),
    ).toEqual([]);
  });

  it("reports a clean build as complete", () => {
    expect(findIncompleteness(parseDiagnostics(""))).toEqual([]);
  });

  it("de-duplicates the same missing file reported many times", () => {
    const reasons = findIncompleteness(
      parseDiagnostics(
        [
          "WARNING: Can't open include file 'shapes.scad'.",
          "WARNING: Can't open include file 'shapes.scad'.",
        ].join("\n"),
      ),
    );
    expect(reasons).toHaveLength(1);
  });
});
