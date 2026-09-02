import type { ScadSchema } from "@datum/scad-schema";
import type { MeshMetricsLike } from "./types.js";

/**
 * The publish gate.
 *
 * "A part that does not compile cannot be published" is the rule that keeps this
 * a registry rather than a file dump, and it eliminates most low-effort spam at
 * the door. Two checks block; the rest are quality advice shown at publish time,
 * when the author is still looking at the file and most likely to act on it.
 *
 * Checks are deliberately explainable. A gate the author cannot understand is a
 * gate they route around.
 */

export type CheckStatus = "pass" | "warn" | "fail";

export interface ReadinessCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** A failing blocking check prevents publication. */
  blocking: boolean;
}

export interface BuildOutcome {
  ok: boolean;
  summary: string;
  metrics: MeshMetricsLike | null;
}

export interface Readiness {
  checks: ReadinessCheck[];
  ready: boolean;
  blockers: string[];
}

/** Below this, the author almost certainly modelled in centimetres or metres. */
const SUSPICIOUS_MIN_MM = 0.5;
/** Above this, likewise -- or they meant micrometres. */
const SUSPICIOUS_MAX_MM = 2000;

export function evaluateReadiness(schema: ScadSchema, build: BuildOutcome): Readiness {
  const checks: ReadinessCheck[] = [];
  const visible = schema.params.filter((p) => !schema.hidden.includes(p.name));

  checks.push({
    id: "builds",
    label: "Compiles to geometry",
    status: build.ok ? "pass" : "fail",
    blocking: true,
    detail: build.ok
      ? `The default configuration builds and produces ${build.metrics?.triangleCount.toLocaleString() ?? "0"} triangles.`
      : build.summary,
  });

  checks.push({
    id: "parametric",
    label: "Has configurable parameters",
    status: visible.length > 0 ? "pass" : "fail",
    blocking: true,
    detail:
      visible.length > 0
        ? `${visible.length} parameter${visible.length === 1 ? "" : "s"} in ${schema.groups.length || 1} group${schema.groups.length === 1 ? "" : "s"}.`
        : "This part has no configurable parameters, so it is a fixed model rather than a parametric one. " +
          "Expose at least one dimension with a Customizer annotation.",
  });

  const metrics = build.metrics;

  checks.push({
    id: "solid",
    label: "Closed, watertight solid",
    status: !build.ok ? "warn" : metrics?.solid ? "pass" : "warn",
    blocking: false,
    detail: !build.ok
      ? "Not checked: the part did not build."
      : metrics?.solid
        ? "Every edge is shared by exactly two faces and the volume is positive."
        : `The mesh is not a closed solid (${metrics?.openEdgeCount ?? 0} open edges, ` +
          `${metrics?.nonManifoldEdgeCount ?? 0} non-manifold edges). Slicers may repair this ` +
          "unpredictably, or refuse it.",
  });

  const undocumented = visible.filter((p) => !p.description);
  checks.push({
    id: "documented",
    label: "Parameters are described",
    status: undocumented.length === 0 ? "pass" : "warn",
    blocking: false,
    detail:
      undocumented.length === 0
        ? "Every parameter has a description comment."
        : `${undocumented.length} parameter${undocumented.length === 1 ? " has" : "s have"} no description: ` +
          `${undocumented.slice(0, 5).map((p) => p.name).join(", ")}` +
          `${undocumented.length > 5 ? ", …" : ""}. Add a comment on the line above each one.`,
  });

  const unbounded = visible.filter(
    (p) => p.type === "number" && p.widget.kind !== "slider" && p.widget.kind !== "select",
  );
  checks.push({
    id: "bounded",
    label: "Numeric parameters have ranges",
    status: unbounded.length === 0 ? "pass" : "warn",
    blocking: false,
    detail:
      unbounded.length === 0
        ? "Every numeric parameter has a range or a set of options."
        : `${unbounded.length} numeric parameter${unbounded.length === 1 ? "" : "s"} without a range: ` +
          `${unbounded.slice(0, 5).map((p) => p.name).join(", ")}` +
          `${unbounded.length > 5 ? ", …" : ""}. Without one, people get a bare number box and ` +
          "can request values you never intended to support.",
  });

  checks.push({
    id: "clean-schema",
    label: "No schema warnings",
    status: schema.warnings.length === 0 ? "pass" : "warn",
    blocking: false,
    detail:
      schema.warnings.length === 0
        ? "The Customizer annotations parsed cleanly."
        : schema.warnings.map((w) => `line ${w.line}: ${w.message}`).join("; "),
  });

  // A units mistake is the single most common way a part is technically valid
  // and completely useless, and it is trivially detectable.
  const span = metrics ? Math.max(...metrics.boundingBox.size) : 0;
  checks.push({
    id: "plausible-size",
    label: "Plausible physical size",
    status:
      !build.ok || !metrics
        ? "warn"
        : span >= SUSPICIOUS_MIN_MM && span <= SUSPICIOUS_MAX_MM
          ? "pass"
          : "warn",
    blocking: false,
    detail: !build.ok || !metrics
      ? "Not checked: the part did not build."
      : span < SUSPICIOUS_MIN_MM
        ? `The part is only ${span.toFixed(3)} mm across. Datum treats all units as millimetres — ` +
          "this usually means the model was drawn in metres."
        : span > SUSPICIOUS_MAX_MM
          ? `The part is ${(span / 1000).toFixed(2)} m across, which will not fit on any common machine. ` +
            "Check the units."
          : `Largest dimension is ${span.toFixed(1)} mm.`,
  });

  const blockers = checks.filter((c) => c.blocking && c.status === "fail").map((c) => c.label);
  return { checks, ready: blockers.length === 0, blockers };
}
