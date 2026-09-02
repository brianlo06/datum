import type {
  Param,
  ParamType,
  ParamValue,
  ParseWarning,
  ScadSchema,
  SelectOption,
  Widget,
} from "./types.js";

const GROUP_MARKER = /^\s*\/\*\s*\[([^\]]*)\]\s*\*\/\s*$/;
const LINE_COMMENT = /^\s*\/\/ ?(.*)$/;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_]*$/;
/** Customizable assignments stop at the first module/function definition. */
const DEFINITION = /^\s*(module|function)\s+[A-Za-z_$]/;
const DEFAULT_GROUP = "Parameters";
const HIDDEN_GROUP = "Hidden";

/**
 * Scan a line tracking string and bracket state.
 * OpenSCAD strings are double-quoted with backslash escapes; there is no
 * character literal, which keeps this simple.
 */
interface ScanState {
  depth: number;
  inString: boolean;
}

function scan(text: string, state: ScanState): { semicolonAt: number; commentAt: number } {
  let semicolonAt = -1;
  let commentAt = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (state.inString) {
      if (ch === "\\") i++;
      else if (ch === '"') state.inString = false;
      continue;
    }
    if (ch === '"') {
      state.inString = true;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      if (commentAt === -1) commentAt = i;
      break; // rest of the line is a comment
    }
    if (ch === "[" || ch === "(" || ch === "{") state.depth++;
    else if (ch === "]" || ch === ")" || ch === "}") state.depth--;
    else if (ch === ";" && state.depth === 0 && semicolonAt === -1) semicolonAt = i;
  }
  return { semicolonAt, commentAt };
}

/** Split on a delimiter at bracket depth 0, ignoring string contents. */
function splitTopLevel(text: string, delim: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === delim && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

function isNumeric(s: string): boolean {
  return s.length > 0 && Number.isFinite(Number(s));
}

/** A step that divides the range into ~100 parts, snapped to 1/2/5 x 10^k. */
function niceStep(min: number, max: number): number {
  const span = Math.abs(max - min);
  if (span === 0) return 1;
  const rough = span / 100;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const snapped = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return snapped * mag;
}

/** Parse an OpenSCAD literal into a typed default. Returns null if unsupported. */
export function parseLiteral(raw: string): { type: ParamType; value: ParamValue } | null {
  const s = raw.trim();
  if (s === "true") return { type: "boolean", value: true };
  if (s === "false") return { type: "boolean", value: false };
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return { type: "string", value: unescapeScadString(s.slice(1, -1)) };
  }
  if (isNumeric(s)) return { type: "number", value: Number(s) };
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return { type: "vector", value: [] };
    const parts = splitTopLevel(inner, ",").map((p) => p.trim());
    if (parts.every(isNumeric)) return { type: "vector", value: parts.map(Number) };
    return null; // nested or expression vectors are not configurable
  }
  return null; // an expression, not a literal -- not a customizable parameter
}

function unescapeScadString(s: string): string {
  return s.replace(/\\(["\\nrt])/g, (_m, c: string) =>
    c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c,
  );
}

function parseOptionToken(token: string): SelectOption {
  const t = token.trim();
  // `value:label` -- the label may contain anything, including further colons.
  const colon = indexOfTopLevel(t, ":");
  const rawValue = colon === -1 ? t : t.slice(0, colon).trim();
  const label = colon === -1 ? undefined : t.slice(colon + 1).trim();
  const value: number | string = isNumeric(rawValue)
    ? Number(rawValue)
    : stripQuotes(rawValue);
  return { value, label: label && label.length > 0 ? label : String(value) };
}

function indexOfTopLevel(text: string, ch: string): number {
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === ch) return i;
  }
  return -1;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') && t.length >= 2
    ? unescapeScadString(t.slice(1, -1))
    : t;
}

/**
 * Interpret a Customizer annotation comment.
 *
 * Supported forms, matching OpenSCAD:
 *   [min:max]            numeric slider
 *   [min:step:max]       numeric slider with explicit step
 *   [a, b, c]            dropdown of values
 *   [a:Label A, b:Label B]  dropdown with labels
 *   12                   maximum length, strings only
 */
export function parseAnnotation(
  annotation: string | undefined,
  type: ParamType,
  def: ParamValue,
  line: number,
  warnings: ParseWarning[],
): Widget {
  const fallback = (): Widget => {
    if (type === "boolean") return { kind: "checkbox" };
    if (type === "string") return { kind: "text" };
    if (type === "vector") return { kind: "vector", length: (def as number[]).length };
    return { kind: "spinbox" };
  };

  const ann = annotation?.trim();
  if (!ann) return fallback();

  if (ann.startsWith("[") && ann.endsWith("]")) {
    const inner = ann.slice(1, -1).trim();
    const commaParts = splitTopLevel(inner, ",");

    if (commaParts.length > 1) {
      if (type === "vector") {
        warnings.push({ line, message: `Dropdown annotation is not supported for vector parameters` });
        return fallback();
      }
      const options = commaParts.map(parseOptionToken);
      return { kind: "select", options };
    }

    const colonParts = splitTopLevel(inner, ":").map((p) => p.trim());
    if (colonParts.length === 2 || colonParts.length === 3) {
      if (!colonParts.every(isNumeric)) {
        // A single labelled option, e.g. [1:One]
        if (type !== "vector") return { kind: "select", options: [parseOptionToken(inner)] };
        warnings.push({ line, message: `Could not interpret annotation "${ann}"` });
        return fallback();
      }
      const nums = colonParts.map(Number) as number[];
      const min = nums[0]!;
      const max = colonParts.length === 2 ? nums[1]! : nums[2]!;
      const step = colonParts.length === 3 ? nums[1]! : undefined;
      if (max < min) {
        warnings.push({ line, message: `Range max (${max}) is below min (${min})` });
        return fallback();
      }
      if (type === "vector") {
        return {
          kind: "vector",
          length: (def as number[]).length,
          min,
          max,
          step: step ?? niceStep(min, max),
        };
      }
      if (type !== "number") {
        warnings.push({ line, message: `Range annotation ignored on a ${type} parameter` });
        return fallback();
      }
      const allInts =
        Number.isInteger(min) && Number.isInteger(max) && Number.isInteger(def as number);
      return { kind: "slider", min, max, step: step ?? (allInts ? 1 : niceStep(min, max)) };
    }

    if (colonParts.length === 1 && inner.length > 0 && type !== "vector") {
      return { kind: "select", options: [parseOptionToken(inner)] };
    }

    warnings.push({ line, message: `Could not interpret annotation "${ann}"` });
    return fallback();
  }

  if (type === "string" && /^\d+$/.test(ann)) {
    return { kind: "text", maxLength: Number(ann) };
  }

  warnings.push({ line, message: `Ignored unrecognised annotation "${ann}"` });
  return fallback();
}

/**
 * Extract the customizable parameter schema from OpenSCAD source.
 *
 * Only top-level assignments appearing before the first module or function
 * definition are customizable -- this mirrors OpenSCAD itself, and it is also
 * what makes the schema safe to derive without evaluating the file.
 */
export function parseScad(source: string): ScadSchema {
  const rawLines = source.split(/\r?\n/);
  const params: Param[] = [];
  const groups: string[] = [];
  const hidden: string[] = [];
  const warnings: ParseWarning[] = [];
  const seen = new Set<string>();

  let group = DEFAULT_GROUP;
  let hiddenFromHere = false;
  let pendingDescription: string[] = [];
  let inBlockComment = false;

  // Buffer for assignments spanning several physical lines.
  let buffer = "";
  let bufferStart = 0;
  const state: ScanState = { depth: 0, inString: false };

  const flushDescription = () => {
    pendingDescription = [];
  };

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    const lineNo = i + 1;

    if (inBlockComment) {
      if (raw.includes("*/")) inBlockComment = false;
      continue;
    }

    if (buffer === "") {
      const groupMatch = raw.match(GROUP_MARKER);
      if (groupMatch) {
        const name = groupMatch[1]!.trim();
        if (name === HIDDEN_GROUP) {
          hiddenFromHere = true;
        } else {
          hiddenFromHere = false;
          group = name.length > 0 ? name : DEFAULT_GROUP;
          if (!groups.includes(group)) groups.push(group);
        }
        flushDescription();
        continue;
      }

      const commentMatch = raw.match(LINE_COMMENT);
      if (commentMatch) {
        pendingDescription.push(commentMatch[1]!.trim());
        continue;
      }

      if (raw.trim() === "") {
        flushDescription();
        continue;
      }

      // A block comment that isn't a group marker: skip it wholesale.
      if (/^\s*\/\*/.test(raw) && !raw.includes("*/")) {
        inBlockComment = true;
        flushDescription();
        continue;
      }

      if (DEFINITION.test(raw)) break; // customizable region ends here

      // include/use directives and anything else non-assignment
      if (/^\s*(include|use)\s*</.test(raw)) {
        flushDescription();
        continue;
      }

      bufferStart = lineNo;
    }

    buffer = buffer === "" ? raw : `${buffer}\n${raw}`;
    const { semicolonAt, commentAt } = scan(raw, state);

    if (semicolonAt === -1) {
      if (state.depth === 0 && !state.inString && buffer.length > 4000) {
        // Runaway: give up on this statement rather than swallowing the file.
        warnings.push({ line: bufferStart, message: "Unterminated statement; skipped" });
        buffer = "";
        state.depth = 0;
        state.inString = false;
        flushDescription();
      }
      continue;
    }

    // We have a complete statement. Recompute offsets against the whole buffer.
    const bufferSemicolon = buffer.length - raw.length + semicolonAt;
    const statement = buffer.slice(0, bufferSemicolon);
    const trailing =
      commentAt !== -1 && commentAt > semicolonAt ? raw.slice(commentAt + 2).trim() : undefined;

    buffer = "";
    state.depth = 0;
    state.inString = false;

    const eq = indexOfTopLevel(statement, "=");
    if (eq === -1) {
      flushDescription();
      continue;
    }
    const name = statement.slice(0, eq).trim();
    const rhs = statement.slice(eq + 1).trim();

    if (!IDENT.test(name)) {
      flushDescription();
      continue;
    }
    if (name.startsWith("$")) {
      // Special variables ($fn, $fa, ...) are rendering knobs, not part parameters.
      flushDescription();
      continue;
    }
    if (seen.has(name)) {
      warnings.push({ line: bufferStart, message: `Duplicate assignment to "${name}"; later value wins in OpenSCAD` });
    }

    const literal = parseLiteral(rhs);
    if (!literal) {
      if (trailing) {
        warnings.push({
          line: bufferStart,
          message: `"${name}" has a Customizer annotation but its value is an expression, so it cannot be configured`,
        });
      }
      flushDescription();
      continue;
    }

    const description = pendingDescription.filter((d) => d.length > 0).join(" ") || undefined;
    const widget = parseAnnotation(trailing, literal.type, literal.value, bufferStart, warnings);

    seen.add(name);
    if (hiddenFromHere) hidden.push(name);
    if (!hiddenFromHere && !groups.includes(group)) groups.push(group);

    params.push({
      name,
      type: literal.type,
      default: literal.value,
      raw: rhs,
      group: hiddenFromHere ? HIDDEN_GROUP : group,
      ...(description ? { description } : {}),
      widget,
      line: bufferStart,
    });
    flushDescription();
  }

  return { params, groups, hidden, warnings };
}
