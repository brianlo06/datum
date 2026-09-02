/**
 * Turn OpenSCAD's stderr into structured, human-readable diagnostics.
 *
 * The brief's requirement was that a failed build "tells them exactly why in
 * plain language". OpenSCAD's own output is terse and assumes you are sitting in
 * the GUI looking at your own file, so we parse it and, where we recognise a
 * failure, say what it means and what to do about it.
 */

export type DiagnosticLevel = "error" | "warning" | "info";

export interface Diagnostic {
  level: DiagnosticLevel;
  /** OpenSCAD's original message, always preserved. */
  raw: string;
  /** Plain-language explanation when we recognise the failure. */
  explanation?: string;
  /** Suggested fix when there is an obvious one. */
  hint?: string;
  file?: string;
  line?: number;
}

const LINE_RE = /^(?<level>WARNING|ERROR|UI-WARNING|UI-ERROR|TRACE|INFO):\s*(?<body>.*)$/;
const LOCATION_RE = /\bin file ([^,]+), line (\d+)/;

interface Rule {
  match: RegExp;
  explanation: string;
  hint?: string;
}

/**
 * Recognised failures, most specific first. Every entry here is a real message
 * OpenSCAD emits; unrecognised messages pass through untranslated rather than
 * being guessed at.
 */
const RULES: Rule[] = [
  {
    match: /Parser error|syntax error/i,
    explanation: "The source could not be parsed, so nothing was built.",
    hint: "Check for a missing semicolon, bracket, or brace at or just before the reported line.",
  },
  {
    match: /Can'?t open input file|Unable to open .*\.scad/i,
    explanation: "An included file could not be found.",
    hint: "Datum builds each part in isolation, so `include <>` and `use <>` can only reference files published with the part. External library includes are not resolved yet.",
  },
  {
    match: /Ignoring unknown (variable|module|function) '(?<name>[^']+)'/i,
    explanation: "The source referred to a name that does not exist.",
    hint: "Usually a typo, or a library that was not included with the part.",
  },
  {
    match: /Current top level object is empty/i,
    explanation: "The build succeeded but produced no geometry at all.",
    hint: "This normally means the chosen parameters cancelled the model out, or the top-level module was never called.",
  },
  {
    match: /Object may not be a valid 2-manifold/i,
    explanation: "The geometry has self-intersections or coincident faces, so it may not slice or print correctly.",
    hint: "Overlapping solids in a union, or two faces sharing exactly the same plane, are the usual causes.",
  },
  {
    match: /No top level geometry to render/i,
    explanation: "Nothing was rendered: the file defines modules but never instantiates any of them.",
    hint: "Add a call to the top-level module at the end of the file.",
  },
  {
    match: /Recursion detected|maximum recursion depth/i,
    explanation: "The model recursed too deeply and the build was stopped.",
    hint: "A recursive module is probably missing its termination condition for these parameter values.",
  },
  {
    match: /assertion .*failed/i,
    explanation: "An assert() in the source rejected these parameter values.",
    hint: "The author has declared this combination of parameters invalid; the assertion message says why.",
  },
];

export function parseDiagnostics(stderr: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const m = LINE_RE.exec(line);
    if (!m || !m.groups) continue;

    const tag = m.groups.level!;
    if (tag === "TRACE" || tag === "INFO") continue;
    const level: DiagnosticLevel = tag.endsWith("ERROR") ? "error" : "warning";
    const body = m.groups.body!.trim();

    const diagnostic: Diagnostic = { level, raw: body };

    const loc = LOCATION_RE.exec(body);
    if (loc) {
      diagnostic.file = loc[1]!.trim();
      diagnostic.line = Number(loc[2]);
    }

    const rule = RULES.find((r) => r.match.test(body));
    if (rule) {
      diagnostic.explanation = rule.explanation;
      if (rule.hint) diagnostic.hint = rule.hint;
    }

    out.push(diagnostic);
  }
  return out;
}

/** The single sentence to show when a build fails. */
export function summarize(diagnostics: Diagnostic[], fallback: string): string {
  const firstError = diagnostics.find((d) => d.level === "error");
  if (firstError) return firstError.explanation ?? firstError.raw;
  const known = diagnostics.find((d) => d.explanation !== undefined);
  if (known) return known.explanation!;
  return fallback;
}
