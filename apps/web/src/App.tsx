import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ParamForm } from "./ParamForm";
import { Viewer } from "./Viewer";
import type { BuildResult, PartDetail, ParamValue, ValidationFailure } from "./types";

const PART = { owner: "datum", slug: "corner-bracket-2020" };
const DEBOUNCE_MS = 450;

const fmt = (n: number, d = 1) =>
  n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: d });

export default function App() {
  const [part, setPart] = useState<PartDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, ParamValue>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [building, setBuilding] = useState(false);
  // When a configuration fails to build we keep the last geometry on screen
  // rather than blanking the viewport -- losing your view every time you drag a
  // slider past a valid range is worse than showing a clearly-labelled stale
  // model. It is only ever shown with a badge saying what it is.
  const [lastGoodUrl, setLastGoodUrl] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    fetch(`/api/parts/${PART.owner}/${PART.slug}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`Could not load the part (HTTP ${r.status}).`);
        return (await r.json()) as PartDetail;
      })
      .then((p) => {
        setPart(p);
        const initial: Record<string, ParamValue> = {};
        for (const param of p.schema.params) initial[param.name] = param.default;
        setValues(initial);
      })
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  const defaults = useMemo(() => {
    const d: Record<string, ParamValue> = {};
    for (const p of part?.schema.params ?? []) d[p.name] = p.default;
    return d;
  }, [part]);

  const dirty = useMemo(
    () => Object.keys(defaults).some((k) => JSON.stringify(defaults[k]) !== JSON.stringify(values[k])),
    [defaults, values],
  );

  const runBuild = useCallback(async (payload: Record<string, ParamValue>) => {
    const id = ++requestId.current;
    setBuilding(true);
    try {
      const res = await fetch(`/api/parts/${PART.owner}/${PART.slug}/build`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params: payload }),
      });

      if (res.status === 422) {
        const failure = (await res.json()) as ValidationFailure;
        if (id !== requestId.current) return;
        const map: Record<string, string> = {};
        for (const e of failure.errors) map[e.param] = e.message;
        setFieldErrors(map);
        return;
      }
      if (!res.ok) {
        if (id !== requestId.current) return;
        setBuild({
          buildHash: "",
          ok: false,
          cached: false,
          summary:
            res.status === 503
              ? "The build service is busy. Try again in a moment."
              : `The build service returned an error (HTTP ${res.status}).`,
          diagnostics: [],
          metrics: null,
          durationMs: 0,
          params: payload,
          configured: false,
          stlUrl: null,
          previewUrl: null,
        });
        return;
      }

      const result = (await res.json()) as BuildResult;
      if (id !== requestId.current) return; // a newer request has superseded this one
      setFieldErrors({});
      setBuild(result);
      if (result.ok && result.stlUrl) setLastGoodUrl(result.stlUrl);
    } catch {
      if (id === requestId.current) {
        setBuild((prev) =>
          prev ? { ...prev, ok: false, summary: "Could not reach the build service." } : prev,
        );
      }
    } finally {
      if (id === requestId.current) setBuilding(false);
    }
  }, []);

  // Rebuild on change, debounced so dragging a slider does not queue 40 builds.
  useEffect(() => {
    if (!part) return;
    const timer = setTimeout(() => void runBuild(values), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [values, part, runBuild]);

  const setValue = useCallback((name: string, value: ParamValue) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const reset = useCallback(() => setValues(defaults), [defaults]);

  if (loadError) {
    return (
      <main className="shell">
        <div className="empty">
          <h1>Datum</h1>
          <p>{loadError}</p>
          <p className="muted">Is the API running on port 8080, and has the database been seeded?</p>
        </div>
      </main>
    );
  }

  if (!part) {
    return (
      <main className="shell">
        <div className="empty">
          <p className="muted">Loading part…</p>
        </div>
      </main>
    );
  }

  const m = build?.metrics ?? null;

  return (
    <div className="shell">
      <header className="masthead">
        <div className="brand">
          <span className="mark">◱</span> Datum
        </div>
        <p className="tagline">
          Parts you can configure, compile and trust — the source is the artifact, the build is the
          quality gate.
        </p>
      </header>

      <main className="layout">
        <section className="pane pane-config">
          <div className="part-head">
            <p className="crumb">
              {part.owner} / <strong>{part.slug}</strong>{" "}
              <span className="version">v{part.version}</span>
            </p>
            <h1>{part.title}</h1>
            <p className="summary">{part.summary}</p>
            <div className="chips">
              <span className="chip chip-license">{part.license}</span>
              {part.interfaces.map((i) => (
                <span key={i.slug + i.role} className={`chip chip-${i.role}`} title={i.description}>
                  {i.role === "implements" ? "implements" : "fits"} {i.name}
                </span>
              ))}
            </div>
          </div>

          <ParamForm
            schema={part.schema}
            values={values}
            errors={fieldErrors}
            onChange={setValue}
            onReset={reset}
            dirty={dirty}
          />
        </section>

        <section className="pane pane-view">
          <div className={`viewport${building ? " is-building" : ""}`}>
            <Viewer url={build?.ok ? build.stlUrl : lastGoodUrl} className="canvas" />
            {building && <div className="build-badge">Compiling…</div>}
            {!building && build?.ok && (
              <div className="build-badge subtle">
                {build.cached ? "cached" : `built in ${build.durationMs} ms`}
              </div>
            )}
            {!building && build && !build.ok && lastGoodUrl && (
              <div className="build-badge stale">showing last build that worked</div>
            )}
            {!building && !lastGoodUrl && !build?.ok && (
              <div className="viewport-empty">
                {build ? "No geometry to show" : "Waiting for the first build…"}
              </div>
            )}
          </div>

          {build && !build.ok && (
            <div className="report report-fail">
              <h3>This configuration does not build</h3>
              <p className="report-summary">{build.summary}</p>
              {build.diagnostics
                .filter((d) => d.level === "error")
                .slice(0, 3)
                .map((d, i) => (
                  <div key={i} className="diag">
                    <code>{d.raw}</code>
                    {d.hint && <p className="hint">{d.hint}</p>}
                  </div>
                ))}
            </div>
          )}

          {m && build?.ok && (
            <div className="report">
              <div className="report-head">
                <h3>Dimension report</h3>
                <div className="verdict">
                  <span className={`pill ${m.solid ? "pass" : "warn"}`}>
                    {m.solid ? "Solid, watertight" : "Not a closed solid"}
                  </span>
                  {m.degenerateTriangleCount > 0 && (
                    <span className="pill warn">{m.degenerateTriangleCount} degenerate faces</span>
                  )}
                </div>
              </div>
              <dl className="metrics">
                <div>
                  <dt>Bounding box</dt>
                  <dd>
                    {m.boundingBox.size.map((n) => fmt(n, 2)).join(" × ")} <span className="u">mm</span>
                  </dd>
                </div>
                <div>
                  <dt>Volume</dt>
                  <dd>
                    {fmt(m.volumeMm3, 0)} <span className="u">mm³</span>
                  </dd>
                </div>
                <div>
                  <dt>Mass in PETG</dt>
                  <dd>
                    {fmt((m.volumeMm3 / 1000) * 1.27, 1)} <span className="u">g solid</span>
                  </dd>
                </div>
                <div>
                  <dt>Surface area</dt>
                  <dd>
                    {fmt(m.surfaceAreaMm2, 0)} <span className="u">mm²</span>
                  </dd>
                </div>
                <div>
                  <dt>Triangles</dt>
                  <dd>{m.triangleCount.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Open edges</dt>
                  <dd>{m.openEdgeCount}</dd>
                </div>
              </dl>

              {build.diagnostics.filter((d) => d.level === "warning").length > 0 && (
                <ul className="warnings">
                  {build.diagnostics
                    .filter((d) => d.level === "warning")
                    .slice(0, 3)
                    .map((d, i) => (
                      <li key={i}>{d.explanation ?? d.raw}</li>
                    ))}
                </ul>
              )}

              <div className="actions">
                <a className="primary" href={build.stlUrl ?? "#"} download={`${part.slug}.stl`}>
                  Download STL
                </a>
                <span className="hash" title="Content address of this exact configuration">
                  {build.buildHash.slice(0, 12)}
                </span>
                {build.configured && <span className="tag-configured">configured</span>}
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
