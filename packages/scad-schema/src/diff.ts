import type { Param, ScadSchema, Widget } from "./types.js";

/**
 * Comparing two versions of a part's parameter schema.
 *
 * This exists to answer one question: does the new version still fit? A part's
 * schema is its public interface, so removing a parameter or narrowing a range
 * breaks anyone holding a saved configuration, exactly as removing a function
 * argument breaks callers. Datum uses this to propose the version bump rather
 * than trusting the author to remember.
 */

export type ChangeKind = "type" | "default" | "range" | "options" | "group" | "widget";

/** Whether a change can break an existing configuration. */
export type Severity = "breaking" | "additive" | "cosmetic";

export interface ParamChange {
  name: string;
  kind: ChangeKind;
  severity: Severity;
  from: string;
  to: string;
  detail: string;
}

export interface SchemaDiff {
  added: string[];
  removed: string[];
  changed: ParamChange[];
  /** True when nothing about the interface changed. */
  identical: boolean;
}

function describeWidget(w: Widget): string {
  switch (w.kind) {
    case "slider":
      return `slider ${w.min}..${w.max} step ${w.step}`;
    case "select":
      return `select(${w.options.map((o) => String(o.value)).join(", ")})`;
    case "vector":
      return `vector[${w.length}]${w.min !== undefined ? ` ${w.min}..${w.max}` : ""}`;
    case "text":
      return w.maxLength === undefined ? "text" : `text(max ${w.maxLength})`;
    default:
      return w.kind;
  }
}

function rangeOf(w: Widget): { min: number; max: number } | null {
  if (w.kind === "slider") return { min: w.min, max: w.max };
  if (w.kind === "vector" && w.min !== undefined && w.max !== undefined) {
    return { min: w.min, max: w.max };
  }
  return null;
}

function optionsOf(w: Widget): string[] | null {
  return w.kind === "select" ? w.options.map((o) => String(o.value)) : null;
}

function compareParam(prev: Param, next: Param): ParamChange[] {
  const changes: ParamChange[] = [];

  if (prev.type !== next.type) {
    // A type change invalidates every stored value for this parameter.
    changes.push({
      name: next.name,
      kind: "type",
      severity: "breaking",
      from: prev.type,
      to: next.type,
      detail: `Type changed from ${prev.type} to ${next.type}, so existing values are no longer valid.`,
    });
    return changes; // further comparison is meaningless across types
  }

  const prevRange = rangeOf(prev.widget);
  const nextRange = rangeOf(next.widget);
  if (prevRange && nextRange) {
    const narrowed = nextRange.min > prevRange.min || nextRange.max < prevRange.max;
    const widened = nextRange.min < prevRange.min || nextRange.max > prevRange.max;
    if (narrowed) {
      changes.push({
        name: next.name,
        kind: "range",
        severity: "breaking",
        from: `${prevRange.min}..${prevRange.max}`,
        to: `${nextRange.min}..${nextRange.max}`,
        detail: "The range narrowed, so configurations that were valid before may now be rejected.",
      });
    } else if (widened) {
      changes.push({
        name: next.name,
        kind: "range",
        severity: "additive",
        from: `${prevRange.min}..${prevRange.max}`,
        to: `${nextRange.min}..${nextRange.max}`,
        detail: "The range widened; every previously valid value still works.",
      });
    }
  } else if ((prevRange === null) !== (nextRange === null)) {
    changes.push({
      name: next.name,
      kind: "widget",
      severity: prevRange === null ? "additive" : "breaking",
      from: describeWidget(prev.widget),
      to: describeWidget(next.widget),
      detail:
        prevRange === null
          ? "A range was added, which constrains an input that was previously unbounded."
          : "The range was removed, loosening a previously constrained input.",
    });
  }

  const prevOptions = optionsOf(prev.widget);
  const nextOptions = optionsOf(next.widget);
  if (prevOptions && nextOptions) {
    const dropped = prevOptions.filter((o) => !nextOptions.includes(o));
    const gained = nextOptions.filter((o) => !prevOptions.includes(o));
    if (dropped.length > 0) {
      changes.push({
        name: next.name,
        kind: "options",
        severity: "breaking",
        from: prevOptions.join(", "),
        to: nextOptions.join(", "),
        detail: `Removed option(s): ${dropped.join(", ")}. Saved configurations using them will fail.`,
      });
    } else if (gained.length > 0) {
      changes.push({
        name: next.name,
        kind: "options",
        severity: "additive",
        from: prevOptions.join(", "),
        to: nextOptions.join(", "),
        detail: `Added option(s): ${gained.join(", ")}.`,
      });
    }
  }

  if (JSON.stringify(prev.default) !== JSON.stringify(next.default)) {
    // Not breaking for anyone who supplies the parameter, but it silently
    // changes the part for everyone who does not -- which is most people.
    changes.push({
      name: next.name,
      kind: "default",
      severity: "additive",
      from: JSON.stringify(prev.default),
      to: JSON.stringify(next.default),
      detail: "The default changed, so anyone who does not set this parameter gets a different part.",
    });
  }

  if (prev.group !== next.group) {
    changes.push({
      name: next.name,
      kind: "group",
      severity: "cosmetic",
      from: prev.group,
      to: next.group,
      detail: "Moved to a different group in the configurator.",
    });
  }

  return changes;
}

export function diffSchemas(prev: ScadSchema, next: ScadSchema): SchemaDiff {
  const prevByName = new Map(prev.params.map((p) => [p.name, p] as const));
  const nextByName = new Map(next.params.map((p) => [p.name, p] as const));

  const added = next.params.filter((p) => !prevByName.has(p.name)).map((p) => p.name);
  const removed = prev.params.filter((p) => !nextByName.has(p.name)).map((p) => p.name);

  const changed: ParamChange[] = [];
  for (const [name, nextParam] of nextByName) {
    const prevParam = prevByName.get(name);
    if (prevParam) changed.push(...compareParam(prevParam, nextParam));
  }

  return {
    added,
    removed,
    changed,
    identical: added.length === 0 && removed.length === 0 && changed.length === 0,
  };
}
