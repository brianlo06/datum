import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, identity } from "../api";
import { Link, navigate } from "../router";
import type {
  Interface,
  InterfaceClaim,
  License,
  Preflight,
  Readiness,
  ReadinessCheck,
  VendoredLibrary,
} from "../types";

const EXAMPLE = `// A parametric spacer
// Every value people should be able to change gets a Customizer annotation,
// and a comment above it becomes its label.

/* [Size] */
// Outer diameter
outer_d = 20;  // [8:0.5:60]
// Hole diameter
inner_d = 8.2; // [2:0.1:40]
// Height
height = 6;    // [1:0.5:40]

/* [Hidden] */
$fn = 64;

difference() {
    cylinder(d = outer_d, h = height);
    translate([0, 0, -0.5])
        cylinder(d = inner_d, h = height + 1);
}
`;

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function Publish() {
  const [source, setSource] = useState("");
  const [checking, setChecking] = useState(false);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [checkedSource, setCheckedSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [summary, setSummary] = useState("");
  const [license, setLicense] = useState("CC-BY-4.0");
  const [claims, setClaims] = useState<InterfaceClaim[]>([]);

  const [licenses, setLicenses] = useState<License[]>([]);
  const [interfaces, setInterfaces] = useState<Interface[]>([]);
  const [libraries, setLibraries] = useState<VendoredLibrary[]>([]);
  const [me, setMe] = useState(() => identity.get());
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  useEffect(() => {
    api.licenses().then((r) => setLicenses(r.licenses)).catch(() => setLicenses([]));
    api.interfaces().then((r) => setInterfaces(r.interfaces)).catch(() => setInterfaces([]));
    api.libraries().then((r) => setLibraries(r.libraries)).catch(() => setLibraries([]));
  }, []);

  const stale = preflight !== null && checkedSource !== source;

  const check = useCallback(async () => {
    if (source.trim() === "") return;
    setChecking(true);
    setError(null);
    try {
      const result = await api.preflight(source);
      setPreflight(result);
      setCheckedSource(source);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not check the part.");
      setPreflight(null);
    } finally {
      setChecking(false);
    }
  }, [source]);

  const onFile = useCallback(async (file: File) => {
    setSource(await file.text());
    setPreflight(null);
    if (!slugTouched && title === "") {
      const base = file.name.replace(/\.scad$/i, "");
      setTitle(base.replace(/[-_]+/g, " "));
    }
  }, [slugTouched, title]);

  const effectiveSlug = slugTouched ? slug : slugify(title);

  const publish = useCallback(async () => {
    setPublishing(true);
    setPublishError(null);
    try {
      const result = await api.publish({
        slug: effectiveSlug,
        title: title.trim(),
        summary: summary.trim(),
        license,
        interfaces: claims,
        source,
      });
      navigate(`/${result.owner}/${result.slug}`);
    } catch (e) {
      setPublishError(e instanceof ApiError ? e.message : "Publishing failed.");
    } finally {
      setPublishing(false);
    }
  }, [effectiveSlug, title, summary, license, claims, source]);

  const detailsValid =
    title.trim() !== "" && /^[a-z0-9][a-z0-9-]{1,63}$/.test(effectiveSlug) && claims.length > 0;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Publish a part</h1>
        <p className="lede">
          Paste the parametric source. Datum compiles it in a sandbox, measures what came out, and
          tells you what is wrong before anyone else sees it. Parts that do not build are not listed.
        </p>
      </header>

      <section className="step">
        <div className="step-head">
          <h2>
            <span className="step-n">1</span> Source
          </h2>
          <div className="step-actions">
            <FilePicker onFile={onFile} />
            {source.trim() === "" && (
              <button type="button" className="ghost" onClick={() => setSource(EXAMPLE)}>
                Use an example
              </button>
            )}
          </div>
        </div>
        <textarea
          className="source"
          spellCheck={false}
          value={source}
          placeholder="Paste your .scad source here, or drop a file above."
          onChange={(e) => setSource(e.target.value)}
          rows={16}
        />
        {libraries.length > 0 && (
          <p className="libs-note">
            Builds are isolated. <code>include &lt;&gt;</code> resolves against files you publish
            with the part, plus{" "}
            {libraries.map((l, i) => (
              <span key={l.name}>
                {i > 0 && (i === libraries.length - 1 ? " and " : ", ")}
                <code title={`${l.include} — ${l.license}`}>
                  {l.name} {l.version}
                </code>
              </span>
            ))}
            .
          </p>
        )}
        <div className="step-foot">
          <button
            type="button"
            className="primary"
            onClick={() => void check()}
            disabled={checking || source.trim() === ""}
          >
            {checking ? "Compiling…" : preflight ? "Check again" : "Check this part"}
          </button>
          {stale && <span className="stale-note">The source changed since the last check.</span>}
          {error && <span className="inline-error">{error}</span>}
        </div>
      </section>

      {preflight && (
        <section className="step">
          <div className="step-head">
            <h2>
              <span className="step-n">2</span> Build report
            </h2>
            <span className={`verdict-pill ${preflight.readiness.ready ? "pass" : "fail"}`}>
              {preflight.readiness.ready ? "Ready to publish" : "Not ready"}
            </span>
          </div>
          <BuildReport preflight={preflight} />
        </section>
      )}

      {preflight?.readiness.ready && (
        <section className="step">
          <div className="step-head">
            <h2>
              <span className="step-n">3</span> Details
            </h2>
          </div>

          <div className="field">
            <label htmlFor="title">
              <span className="field-name">Title</span>
            </label>
            <input
              id="title"
              type="text"
              value={title}
              placeholder="2020 Corner Bracket"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="slug">
              <span className="field-name">Address</span>
              <code className="field-key">
                /{me?.handle ?? "your-handle"}/{effectiveSlug || "…"}
              </code>
            </label>
            <input
              id="slug"
              type="text"
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
            />
          </div>

          <div className="field">
            <label htmlFor="summary">
              <span className="field-name">Summary</span>
            </label>
            <textarea
              id="summary"
              rows={3}
              value={summary}
              placeholder="What is it for, and what does it need? Fasteners, inserts, bearings."
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>

          <LicensePicker licenses={licenses} value={license} onChange={setLicense} />
          <InterfacePicker interfaces={interfaces} claims={claims} onChange={setClaims} />
        </section>
      )}

      {preflight?.readiness.ready && (
        <section className="step">
          <div className="step-head">
            <h2>
              <span className="step-n">4</span> Publish
            </h2>
          </div>

          {!me ? (
            <ClaimHandle
              onClaimed={(handle, token) => {
                identity.set(handle, token);
                setMe({ handle, token });
              }}
            />
          ) : (
            <div className="publish-row">
              <p className="publishing-as">
                Publishing as <strong>{me.handle}</strong> at version <strong>1.0.0</strong>.
              </p>
              <button
                type="button"
                className="primary big"
                onClick={() => void publish()}
                disabled={!detailsValid || publishing || stale}
              >
                {publishing ? "Publishing…" : "Publish part"}
              </button>
              {!detailsValid && (
                <p className="hint">
                  A title, a valid address and at least one interface are required.
                </p>
              )}
              {stale && (
                <p className="hint">Re-check the source before publishing; it changed since the last build.</p>
              )}
              {publishError && <p className="inline-error">{publishError}</p>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function FilePicker({ onFile }: { onFile: (file: File) => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button type="button" className="ghost" onClick={() => ref.current?.click()}>
        Open a .scad file
      </button>
      <input
        ref={ref}
        type="file"
        accept=".scad,text/plain"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </>
  );
}

function BuildReport({ preflight }: { preflight: Preflight }) {
  const { readiness, build, schema } = preflight;
  const preview = useMemo(
    () => (build.previewBase64 ? `data:image/png;base64,${build.previewBase64}` : null),
    [build.previewBase64],
  );
  const visible = schema.params.filter((p) => !schema.hidden.includes(p.name));

  return (
    <div className="report-grid">
      <div className="report-preview">
        {preview ? (
          <img src={preview} alt="Rendered preview of the default configuration" />
        ) : (
          <div className="preview-empty">No preview</div>
        )}
        {build.metrics && (
          <dl className="mini-metrics">
            <div>
              <dt>Size</dt>
              <dd>{build.metrics.boundingBox.size.map((n) => n.toFixed(1)).join(" × ")} mm</dd>
            </div>
            <div>
              <dt>Volume</dt>
              <dd>{Math.round(build.metrics.volumeMm3).toLocaleString()} mm³</dd>
            </div>
            <div>
              <dt>Built in</dt>
              <dd>{build.durationMs} ms</dd>
            </div>
          </dl>
        )}
      </div>

      <div className="report-checks">
        <ChecksList readiness={readiness} />
        {visible.length > 0 && (
          <div className="param-preview">
            <h4>Configurator preview</h4>
            <p className="muted small">
              {visible.length} parameter{visible.length === 1 ? "" : "s"} in{" "}
              {schema.groups.length || 1} group{schema.groups.length === 1 ? "" : "s"}
              {schema.hidden.length > 0 && `, ${schema.hidden.length} hidden`}
            </p>
            <ul className="param-list">
              {visible.slice(0, 10).map((p) => (
                <li key={p.name}>
                  <code>{p.name}</code>
                  <span className="param-desc">{p.description ?? <em>no description</em>}</span>
                  <span className="param-widget">
                    {p.widget.kind === "slider"
                      ? `${p.widget.min}–${p.widget.max}`
                      : p.widget.kind === "select"
                        ? `${p.widget.options.length} options`
                        : p.widget.kind}
                  </span>
                </li>
              ))}
            </ul>
            {visible.length > 10 && <p className="muted small">…and {visible.length - 10} more.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChecksList({ readiness }: { readiness: Readiness }) {
  return (
    <ul className="checks">
      {readiness.checks.map((c) => (
        <CheckRow key={c.id} check={c} />
      ))}
    </ul>
  );
}

function CheckRow({ check }: { check: ReadinessCheck }) {
  const glyph = check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "×";
  return (
    <li className={`check check-${check.status}`}>
      <span className="check-glyph" aria-hidden="true">
        {glyph}
      </span>
      <div>
        <p className="check-label">
          {check.label}
          {check.blocking && check.status === "fail" && <span className="blocking">blocks publishing</span>}
        </p>
        <p className="check-detail">{check.detail}</p>
      </div>
    </li>
  );
}

function LicensePicker({
  licenses,
  value,
  onChange,
}: {
  licenses: License[];
  value: string;
  onChange: (id: string) => void;
}) {
  const chosen = licenses.find((l) => l.id === value);
  return (
    <div className="field">
      <label htmlFor="license">
        <span className="field-name">Licence</span>
        <span className="field-key">required</span>
      </label>
      <select id="license" value={value} onChange={(e) => onChange(e.target.value)}>
        {licenses.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
            {l.recommended ? " — recommended" : ""}
          </option>
        ))}
      </select>
      {chosen && <p className="hint">{chosen.summary}</p>}
    </div>
  );
}

function InterfacePicker({
  interfaces,
  claims,
  onChange,
}: {
  interfaces: Interface[];
  claims: InterfaceClaim[];
  onChange: (claims: InterfaceClaim[]) => void;
}) {
  const [slug, setSlug] = useState("");
  const [role, setRole] = useState<"implements" | "consumes">("consumes");

  const add = () => {
    if (!slug) return;
    if (claims.some((c) => c.slug === slug && c.role === role)) return;
    onChange([...claims, { slug, role }]);
    setSlug("");
  };

  const byslug = new Map(interfaces.map((i) => [i.slug, i] as const));

  return (
    <div className="field">
      <label htmlFor="iface">
        <span className="field-name">Interfaces it fits</span>
        <span className="field-key">at least one</span>
      </label>
      <p className="hint">
        What does this part mate with? This is how people find it by fit rather than by keyword.
      </p>

      <div className="iface-add">
        <select
          id="iface"
          value={role}
          onChange={(e) => setRole(e.target.value as "implements" | "consumes")}
          className="role-select"
        >
          <option value="consumes">fits into / bolts to</option>
          <option value="implements">provides / exposes</option>
        </select>
        <select value={slug} onChange={(e) => setSlug(e.target.value)}>
          <option value="">Choose an interface…</option>
          {interfaces.map((i) => (
            <option key={i.slug} value={i.slug}>
              {i.name} ({i.slug})
            </option>
          ))}
        </select>
        <button type="button" className="ghost" onClick={add} disabled={!slug}>
          Add
        </button>
      </div>

      {claims.length > 0 && (
        <div className="chips">
          {claims.map((c) => (
            <span key={`${c.slug}:${c.role}`} className={`chip chip-${c.role}`}>
              {c.role === "implements" ? "provides" : "fits"} {byslug.get(c.slug)?.name ?? c.slug}
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove ${c.slug}`}
                onClick={() => onChange(claims.filter((x) => !(x.slug === c.slug && x.role === c.role)))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ClaimHandle({ onClaimed }: { onClaimed: (handle: string, token: string) => void }) {
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const claim = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.claimHandle(handle.trim(), displayName.trim() || handle.trim());
      onClaimed(result.handle, result.token);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not claim that handle.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="claim">
      <h3>Claim a handle</h3>
      <p className="hint">
        Your parts live under it. There are no accounts yet — claiming a handle mints a token stored
        in this browser, and it is the only proof of ownership. If you clear site data you lose it.
      </p>
      <div className="claim-row">
        <input
          type="text"
          placeholder="handle"
          value={handle}
          onChange={(e) => setHandle(e.target.value.toLowerCase())}
        />
        <input
          type="text"
          placeholder="display name (optional)"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <button
          type="button"
          className="primary"
          onClick={() => void claim()}
          disabled={busy || !/^[a-z0-9][a-z0-9-]{1,38}$/.test(handle)}
        >
          {busy ? "Claiming…" : "Claim"}
        </button>
      </div>
      {error && <p className="inline-error">{error}</p>}
      <p className="hint">
        Already have one? <Link to="/">Go back</Link> — token recovery does not exist yet.
      </p>
    </div>
  );
}
