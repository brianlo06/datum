import type { Param, ScadSchema, Widget } from "./types.js";

/**
 * Proposing Customizer annotations for parameters that have none.
 *
 * The supply audit found that only 2% of parameters in real OpenSCAD source
 * carry a range or dropdown annotation, and that exactly one part in 112 had all
 * of its parameters annotated. Datum's original wager -- that reading OpenSCAD's
 * existing Customizer syntax makes a configurator free -- therefore does not
 * hold: most parts arrive as a wall of bare assignments and would render as a
 * column of unlabelled number boxes.
 *
 * So the registry has to do the work instead. This proposes a widget and a range
 * for each unannotated parameter, which the author reviews and accepts. It is
 * deliberately a *suggestion*: nothing is applied silently, because a wrong range
 * is worse than no range -- it would reject configurations the part actually
 * supports.
 *
 * Two sources of evidence, in order of trust:
 *   1. The parameter's name. `bolt_d`, `wall_thickness` and `segments` have
 *      well-understood conventional ranges in mechanical CAD.
 *   2. The default value, which tells us the order of magnitude and whether the
 *      author is working in integers.
 */

export interface Suggestion {
  param: string;
  widget: Widget;
  /** Why this range was proposed, shown to the author so they can judge it. */
  rationale: string;
  /** How much to trust it. Name-based matches are far better than value-based. */
  confidence: "high" | "medium" | "low";
  /** The annotation comment to append to the assignment. */
  annotation: string;
}

interface NameRule {
  match: RegExp;
  /** Given the default, produce min/max/step. */
  range: (value: number) => { min: number; max: number; step: number } | null;
  rationale: string;
}

/**
 * Conventional ranges for names that mean something specific in mechanical CAD.
 * Ordered most specific first.
 */
const NAME_RULES: NameRule[] = [
  {
    match: /(^|_)(tol|tolerance|clearance|slop|fudge|kerf)($|_)/i,
    range: () => ({ min: 0, max: 1, step: 0.05 }),
    rationale: "clearances are conventionally well under a millimetre",
  },
  {
    match: /(^|_)(wall|thickness|thick|t)($|_)/i,
    range: (v) => ({ min: 0.4, max: Math.max(10, round1(v * 3)), step: 0.2 }),
    rationale: "wall thickness starts at one extrusion width",
  },
  {
    match: /(^|_)(bolt|screw|shaft|rod|pin)_?(d|dia|diameter)?($|_)/i,
    range: () => ({ min: 2, max: 12, step: 0.5 }),
    rationale: "fastener diameters in the common metric range",
  },
  {
    match: /(^|_)(d|dia|diameter|od|id|r|radius)($|_)/i,
    range: (v) => ({ min: round1(Math.max(0.5, v / 4)), max: round1(v * 4), step: pickStep(v) }),
    rationale: "a diameter, scaled around the author's default",
  },
  {
    match: /(^|_)(angle|rot|rotation|twist)($|_)/i,
    range: () => ({ min: 0, max: 360, step: 5 }),
    rationale: "a full rotation",
  },
  {
    match: /(^|_)(n|num|count|qty|sides|segments|teeth|holes|copies)($|_)/i,
    range: (v) => ({ min: 1, max: Math.max(12, Math.ceil(v * 4)), step: 1 }),
    rationale: "a count, so whole numbers from one",
  },
  {
    match: /(^|_)(height|h|len|length|width|w|depth|size|span)($|_)/i,
    range: (v) => ({ min: round1(Math.max(1, v / 4)), max: round1(v * 4), step: pickStep(v) }),
    rationale: "a length, scaled around the author's default",
  },
  {
    match: /(^|_)(pitch|spacing|gap|offset)($|_)/i,
    range: (v) => ({ min: round1(Math.max(0.5, v / 4)), max: round1(v * 4), step: pickStep(v) }),
    rationale: "a spacing, scaled around the author's default",
  },
];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** An integer default implies integer steps; otherwise step by a tenth-ish. */
function pickStep(value: number): number {
  if (Number.isInteger(value) && Math.abs(value) >= 4) return 1;
  if (Math.abs(value) >= 1) return 0.5;
  return 0.1;
}

/** Fall back to bracketing the default when the name says nothing. */
function rangeFromValue(value: number): { min: number; max: number; step: number } | null {
  if (value === 0) return { min: 0, max: 10, step: 0.5 };
  if (value < 0) return null; // negative defaults are usually offsets; guessing is unsafe
  return {
    min: round1(Math.max(0, value / 4)),
    max: round1(value * 4),
    step: pickStep(value),
  };
}

function needsSuggestion(param: Param): boolean {
  if (param.type !== "number") return false;
  return param.widget.kind === "spinbox";
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(round1(n));
}

/** Propose annotations for every unannotated numeric parameter in a schema. */
export function suggestAnnotations(schema: ScadSchema): Suggestion[] {
  const out: Suggestion[] = [];

  for (const param of schema.params) {
    if (schema.hidden.includes(param.name)) continue;
    if (!needsSuggestion(param)) continue;

    const value = param.default as number;
    if (!Number.isFinite(value)) continue;

    const rule = NAME_RULES.find((r) => r.match.test(param.name));
    const range = rule ? rule.range(value) : rangeFromValue(value);
    if (!range) continue;

    // A proposal that would reject the author's own default is worse than none.
    const min = Math.min(range.min, value);
    const max = Math.max(range.max, value);
    if (max <= min) continue;

    const step = range.step;
    const widget: Widget = { kind: "slider", min, max, step };
    const annotation = `// [${formatNumber(min)}:${formatNumber(step)}:${formatNumber(max)}]`;

    out.push({
      param: param.name,
      widget,
      rationale: rule
        ? `"${param.name}" looks like ${rule.rationale}`
        : `bracketed around the default of ${formatNumber(value)}`,
      confidence: rule ? "high" : "low",
      annotation,
    });
  }

  return out;
}

/**
 * Apply accepted suggestions to the source text.
 *
 * Edits are made bottom-up by line so earlier edits cannot shift later line
 * numbers, and only the specific assignment line is touched -- the author's
 * formatting, comments and everything else survive untouched. A parameter whose
 * line no longer looks like its assignment is skipped rather than guessed at.
 */
export function applySuggestions(
  source: string,
  schema: ScadSchema,
  suggestions: Suggestion[],
): { source: string; applied: string[]; skipped: string[] } {
  const byName = new Map(schema.params.map((p) => [p.name, p] as const));
  const lines = source.split("\n");
  const applied: string[] = [];
  const skipped: string[] = [];

  const ordered = [...suggestions].sort((a, b) => {
    const la = byName.get(a.param)?.line ?? 0;
    const lb = byName.get(b.param)?.line ?? 0;
    return lb - la;
  });

  for (const suggestion of ordered) {
    const param = byName.get(suggestion.param);
    if (!param) {
      skipped.push(suggestion.param);
      continue;
    }
    const index = param.line - 1;
    const line = lines[index];
    if (line === undefined) {
      skipped.push(suggestion.param);
      continue;
    }

    // Only touch a line that still starts with this assignment and carries no
    // annotation of its own.
    const assignment = new RegExp(`^\\s*${escapeRegExp(param.name)}\\s*=`);
    if (!assignment.test(line)) {
      skipped.push(suggestion.param);
      continue;
    }
    const commentAt = findComment(line);
    if (commentAt !== -1) {
      skipped.push(suggestion.param);
      continue;
    }

    lines[index] = `${line.trimEnd()} ${suggestion.annotation}`;
    applied.push(suggestion.param);
  }

  return { source: lines.join("\n"), applied: applied.reverse(), skipped };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Index of a line comment, ignoring `//` inside a string. */
function findComment(line: string): number {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "/" && line[i + 1] === "/") return i;
  }
  return -1;
}
