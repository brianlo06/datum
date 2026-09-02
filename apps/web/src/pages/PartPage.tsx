import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { ParamForm } from "../ParamForm";
import { Viewer } from "../Viewer";
import type { BuildResult, PartDetail, ParamValue } from "../types";

const DEBOUNCE_MS = 450;

const fmt = (n: number, d = 1) =>
  n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: d });

export function PartPage({ owner, slug }: { owner: string; slug: string }) {
  const [part, setPart] = useState<PartDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, ParamValue>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [building, setBuilding] = useState(false);
  // Keep the last geometry on screen when a configuration fails to build, so a
  // slider crossing an invalid range does not blank the viewport.
  const [lastGoodUrl, setLastGoodUrl] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    setPart(null);
    setBuild(null);
    setLastGoodUrl(null);
    setLoadError(null);
    api
      .part(owner, slug)
      .then((p) => {
        setPart(p);
        const initial: Record<string, ParamValue> = {};
        for (const param of p.schema.params) initial[param.name] = param.default;
        setValues(initial);
      })
      .catch((e: unknown) =>
        setLoadError(
          e instanceof ApiError && e.status === 404
            ? `There is no part at ${owner}/${slug}.`
            : e instanceof ApiError
              ? e.message
              : "Could not load the part.",
        ),
      );
  }, [owner, slug]);

  const defaults = useMemo(() => {
    const d: Record<string, ParamValue> = {};
    for (const p of part?.schema.params ?? []) d[p.name] = p.default;
    return d;
  }, [part]);

  const dirty = useMemo(
    () => Object.keys(defaults).some((k) => JSON.stringify(defaults[k]) !== JSON.stringify(values[k])),
    [defaults, values],
  );

  const runBuild = useCallback(
    async (payload: Record<string, ParamValue>) => {
      const id = ++requestId.current;
      setBuilding(true);
      try {
        const result = await api.build(owner, slug, payload);
        if (id !== requestId.current) return; // superseded by a newer request
        setFieldErrors({});
        setBuild(result);
        if (result.ok && result.stlUrl) setLastGoodUrl(result.stlUrl);
      } catch (e) {
        if (id !== requestId.current) return;
        if (e instanceof ApiError && e.status === 422) {
          const errors = (e.body.errors ?? []) as { param: string; message: string }[];
          const map: Record<string, string> = {};
          for (const err of errors) map[err.param] = err.message;
          setFieldErrors(map);
          return;
        }
        setBuild({
          buildHash: "",
          ok: false,
          cached: false,
          summary:
            e instanceof ApiError && e.status === 503
              ? "The build service is busy. Try again in a moment."
              : e instanceof ApiError
                ? e.message
                : "Could not reach the build service.",
          diagnostics: [],
          metrics: null,
          durationMs: 0,
          params: payload,
          configured: false,
          stlUrl: null,
          previewUrl: null,
        });
      } finally {
        if (id === requestId.current) setBuilding(false);
      }
    },
    [owner, slug],
  );

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
      <div className="empty">
        <p>{loadError}</p>
        <p className="muted">Is the API running on port 8080, and has the database been seeded?</p>
      </div>
    );
  }

  if (!part) {
    return (
      <div className="empty">
        <p className="muted">Loading part…</p>
      </div>
    );
  }

  const m = build?.metrics ?? null;

  return (
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
                {i.role === "implements" ? "provides" : "fits"} {i.name}
              </span>
            ))}
          </div>
          {part.versions.length > 1 && (
            <p className="versions">
              {part.versions.length} versions:{" "}
              {part.versions.map((v) => v.version).join(", ")}
            </p>
          )}
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
  );
}
