/**
 * Static classification of an OpenSCAD file.
 *
 * A great many `.scad` files in the wild are pure libraries: they define modules
 * and functions and instantiate nothing. Building one produces no geometry, and
 * counting that as a failed part would badly overstate the failure rate of real
 * source. So before measuring "does it build", we have to ask "is it even
 * supposed to build".
 *
 * This is a heuristic, and the build remains the ground truth -- OpenSCAD reports
 * an empty top-level object, which catches whatever this misses. Its value is as
 * a cheap pre-filter: a corpus of thousands of files can be reduced to the ones
 * worth compiling without spawning a CAD kernel for each.
 */

/** Top-level calls that exist for their side effects, not their geometry. */
const NON_GEOMETRIC = new Set(["echo", "assert", "version", "version_num"]);

const KEYWORDS = new Set(["module", "function", "include", "use", "let"]);

export interface Classification {
  /** A top-level statement appears to instantiate geometry. */
  hasTopLevelGeometry: boolean;
  /** Names called at the top level, in order of first appearance. */
  topLevelCalls: string[];
  moduleCount: number;
  functionCount: number;
  /** `include <>` / `use <>` targets, which have to resolve for a build to work. */
  includes: string[];
}

/** Remove comments and string contents, preserving offsets and line structure. */
function blank(source: string): string {
  const out = source.split("");
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === '"') {
      out[i] = " ";
      i++;
      while (i < n) {
        if (source[i] === "\\") {
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          out[i] = " ";
          i++;
          break;
        }
        if (source[i] !== "\n") out[i] = " ";
        i++;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < n) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }

    i++;
  }
  return out.join("");
}

const IDENT_CALL = /([A-Za-z_$][A-Za-z0-9_]*)\s*\(/g;
const INCLUDE_RE = /\b(?:include|use)\s*<([^>]*)>/g;

export function classify(source: string): Classification {
  const code = blank(source);

  const includes: string[] = [];
  for (const m of code.matchAll(INCLUDE_RE)) includes.push(m[1]!.trim());

  let moduleCount = 0;
  let functionCount = 0;
  const topLevelCalls: string[] = [];
  const seenCalls = new Set<string>();

  // Walk the file tracking brace depth. Anything inside a `module` or `function`
  // body belongs to a definition, not to the top level.
  let depth = 0;
  let parenDepth = 0;
  IDENT_CALL.lastIndex = 0;

  const words = [...code.matchAll(/[A-Za-z_$][A-Za-z0-9_]*|[{}();=]/g)];
  let pendingDefinition: "module" | "function" | null = null;
  let definitionDepth: number | null = null;

  for (let w = 0; w < words.length; w++) {
    const token = words[w]![0];
    const index = words[w]!.index;

    if (token === "{") {
      depth++;
      if (pendingDefinition === "module" && definitionDepth === null) definitionDepth = depth;
      continue;
    }
    if (token === "}") {
      if (definitionDepth !== null && depth === definitionDepth) {
        definitionDepth = null;
        pendingDefinition = null;
      }
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (token === "(") {
      parenDepth++;
      continue;
    }
    if (token === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (token === ";") {
      // A function definition ends at its semicolon; a module's ends at its brace.
      if (pendingDefinition === "function" && depth === 0) pendingDefinition = null;
      continue;
    }
    if (token === "=" || token === undefined) continue;

    if (token === "module") {
      moduleCount++;
      if (definitionDepth === null) pendingDefinition = "module";
      continue;
    }
    if (token === "function") {
      functionCount++;
      if (definitionDepth === null) pendingDefinition = "function";
      continue;
    }

    const insideDefinition = definitionDepth !== null || pendingDefinition !== null;
    if (insideDefinition || depth > 0 || parenDepth > 0) continue;
    if (KEYWORDS.has(token) || NON_GEOMETRIC.has(token)) continue;

    // A bare identifier followed by "(" at the top level is an instantiation.
    const after = code.slice(index + token.length);
    if (!/^\s*\(/.test(after)) continue;

    // Skip the name in `module foo(...)` / `function foo(...)`, already handled
    // by pendingDefinition, and skip assignments like `x = foo(...)`.
    const before = code.slice(0, index).trimEnd();
    if (/[=,+\-*/%<>!&|?:[]$/.test(before)) continue;

    if (!seenCalls.has(token)) {
      seenCalls.add(token);
      topLevelCalls.push(token);
    }
  }

  return {
    hasTopLevelGeometry: topLevelCalls.length > 0,
    topLevelCalls,
    moduleCount,
    functionCount,
    includes,
  };
}
