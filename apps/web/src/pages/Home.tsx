import { useEffect, useState } from "react";
import { api } from "../api";
import { Link } from "../router";
import type { PartSummary } from "../types";

export function Home() {
  const [parts, setParts] = useState<PartSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .parts()
      .then((r) => setParts(r.parts))
      .catch(() => setError("Could not load the registry."));
  }, []);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Parts</h1>
        <p className="lede">
          Every part here is parametric source, not a mesh. Each one compiled and was measured before
          it was listed.
        </p>
      </header>

      {error && <p className="inline-error">{error}</p>}
      {!parts && !error && <p className="muted">Loading…</p>}

      {parts?.length === 0 && (
        <div className="empty-state">
          <p>Nothing published yet.</p>
          <Link to="/publish" className="primary">
            Publish the first part
          </Link>
        </div>
      )}

      {parts && parts.length > 0 && (
        <ul className="part-grid">
          {parts.map((p) => (
            <li key={`${p.handle}/${p.slug}`}>
              <Link to={`/${p.handle}/${p.slug}`} className="part-card">
                <p className="crumb">
                  {p.handle} / <strong>{p.slug}</strong>
                  {p.latest_version && <span className="version">v{p.latest_version}</span>}
                </p>
                <h2>{p.title}</h2>
                {p.summary && <p className="part-summary">{p.summary}</p>}
                <div className="chips">
                  <span className="chip chip-license">{p.license}</span>
                  {dedupe(p.interfaces).slice(0, 3).map((i) => (
                    <span key={i.slug + i.role} className={`chip chip-${i.role}`}>
                      {i.role === "implements" ? "provides" : "fits"} {i.name}
                    </span>
                  ))}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Interfaces are aggregated across every version, so the same one can repeat. */
function dedupe<T extends { slug: string; role: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = `${i.slug}:${i.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
