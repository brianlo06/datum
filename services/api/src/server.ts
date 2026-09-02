import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  buildHash as computeBuildHash,
  hashSource,
  parseScad,
  toArgs,
  validate,
  type ParamValue,
  type ScadSchema,
} from "@datum/scad-schema";
import { get as getArtifact, put as putArtifact } from "./artifacts.js";
import { migrate, pool } from "./db.js";

const PORT = Number(process.env.API_PORT ?? 8080);
const BUILDER_URL = process.env.BUILDER_URL ?? "http://localhost:8081";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cors, { origin: true });

interface BuilderResponse {
  ok: boolean;
  summary: string;
  diagnostics: unknown[];
  metrics: Record<string, unknown> | null;
  durationMs: number;
  timedOut: boolean;
  artifacts: { stl: string | null; png: string | null };
}

interface VersionRow {
  id: string;
  version: string;
  source: string;
  source_hash: string;
  schema: ScadSchema;
  part_id: string;
  slug: string;
  handle: string;
  title: string;
  summary: string;
  license: string;
}

async function loadVersion(owner: string, slug: string, version?: string): Promise<VersionRow | null> {
  const { rows } = await pool.query<VersionRow>(
    `SELECT v.id, v.version, v.source, v.source_hash, v.schema,
            p.id AS part_id, p.slug, p.title, p.summary, p.license, u.handle
       FROM part_versions v
       JOIN parts p ON p.id = v.part_id
       JOIN users u ON u.id = p.owner_id
      WHERE u.handle = $1 AND p.slug = $2
        AND ($3::text IS NULL OR v.version = $3)
      ORDER BY v.created_at DESC
      LIMIT 1`,
    [owner, slug, version ?? null],
  );
  return rows[0] ?? null;
}

app.get("/health", async () => {
  const { rows } = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM parts");
  let builder: unknown = null;
  try {
    builder = await (await fetch(`${BUILDER_URL}/health`)).json();
  } catch {
    builder = { ok: false, error: "unreachable" };
  }
  return { ok: true, parts: Number(rows[0]?.n ?? 0), builder };
});

/** Browse parts. Ordered by most recently updated; search is a later feature. */
app.get("/api/parts", async () => {
  const { rows } = await pool.query(
    `SELECT u.handle, p.slug, p.title, p.summary, p.license, p.updated_at,
            (SELECT v.version FROM part_versions v WHERE v.part_id = p.id
              ORDER BY v.created_at DESC LIMIT 1) AS latest_version,
            COALESCE((SELECT json_agg(json_build_object('slug', i.slug, 'name', i.name, 'role', pi.role))
               FROM part_interfaces pi
               JOIN interfaces i ON i.id = pi.interface_id
               JOIN part_versions v2 ON v2.id = pi.part_version_id
              WHERE v2.part_id = p.id), '[]'::json) AS interfaces
       FROM parts p
       JOIN users u ON u.id = p.owner_id
      ORDER BY p.updated_at DESC
      LIMIT 100`,
  );
  return { parts: rows };
});

/** The part page: metadata, the parameter schema, and recent fabrication evidence. */
app.get<{ Params: { owner: string; slug: string } }>(
  "/api/parts/:owner/:slug",
  async (request, reply) => {
    const { owner, slug } = request.params;
    const v = await loadVersion(owner, slug);
    if (!v) return reply.code(404).send({ error: "part not found" });

    const [{ rows: interfaces }, { rows: versions }, { rows: made }] = await Promise.all([
      pool.query(
        `SELECT i.slug, i.name, i.description, pi.role
           FROM part_interfaces pi JOIN interfaces i ON i.id = pi.interface_id
          WHERE pi.part_version_id = $1 ORDER BY pi.role, i.slug`,
        [v.id],
      ),
      pool.query(
        `SELECT version, notes, created_at FROM part_versions
          WHERE part_id = $1 ORDER BY created_at DESC`,
        [v.part_id],
      ),
      pool.query(
        `SELECT m.machine, m.material, m.fitted, m.notes, m.created_at
           FROM made_reports m JOIN builds b ON b.build_hash = m.build_hash
          WHERE b.part_version_id = $1 ORDER BY m.created_at DESC LIMIT 20`,
        [v.id],
      ),
    ]);

    return {
      owner: v.handle,
      slug: v.slug,
      title: v.title,
      summary: v.summary,
      license: v.license,
      version: v.version,
      versions,
      schema: v.schema,
      interfaces,
      made,
      source: v.source,
    };
  },
);

/**
 * Configure and compile.
 *
 * This is the endpoint the whole product turns on. It validates against the
 * schema, short-circuits to the cache when this exact configuration has been
 * built before, and otherwise calls the sandboxed builder and records the result.
 */
app.post<{ Params: { owner: string; slug: string }; Body: { params?: Record<string, unknown> } }>(
  "/api/parts/:owner/:slug/build",
  async (request, reply) => {
    const { owner, slug } = request.params;
    const v = await loadVersion(owner, slug);
    if (!v) return reply.code(404).send({ error: "part not found" });

    const requested = request.body?.params ?? {};
    if (typeof requested !== "object" || requested === null || Array.isArray(requested)) {
      return reply.code(400).send({ error: "params must be an object" });
    }

    const result = validate(v.schema, requested);
    if (!result.ok) {
      return reply.code(422).send({ error: "invalid parameters", errors: result.errors });
    }

    const configured = v.schema.params.some(
      (p) => JSON.stringify(result.values[p.name]) !== JSON.stringify(p.default),
    );
    const hash = computeBuildHash(v.source_hash, result.values);

    const cached = await pool.query(
      `SELECT build_hash, ok, summary, diagnostics, metrics, duration_ms, stl_path, png_path
         FROM builds WHERE build_hash = $1`,
      [hash],
    );
    if (cached.rows[0]) {
      const row = cached.rows[0];
      return {
        buildHash: row.build_hash,
        ok: row.ok,
        cached: true,
        summary: row.summary,
        diagnostics: row.diagnostics,
        metrics: row.metrics,
        durationMs: row.duration_ms,
        params: result.values,
        configured,
        stlUrl: row.stl_path ? `/api/builds/${hash}/model.stl` : null,
        previewUrl: row.png_path ? `/api/builds/${hash}/preview.png` : null,
      };
    }

    let built: BuilderResponse;
    try {
      const res = await fetch(`${BUILDER_URL}/build`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: v.source,
          args: toArgs(v.schema, result.values),
          renderPreview: true,
        }),
      });
      if (res.status === 503) {
        return reply.code(503).header("retry-after", "3").send({ error: "builders are busy, retry shortly" });
      }
      built = (await res.json()) as BuilderResponse;
    } catch (err) {
      request.log.error({ err }, "builder unreachable");
      return reply.code(502).send({ error: "the build service is unavailable" });
    }

    let stlPath: string | null = null;
    let pngPath: string | null = null;
    if (built.artifacts.stl) stlPath = await putArtifact(hash, "stl", Buffer.from(built.artifacts.stl, "base64"));
    if (built.artifacts.png) pngPath = await putArtifact(hash, "png", Buffer.from(built.artifacts.png, "base64"));

    await pool.query(
      `INSERT INTO builds (build_hash, part_version_id, params, ok, summary, diagnostics,
                           metrics, stl_path, png_path, duration_ms, configured)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (build_hash) DO NOTHING`,
      [
        hash,
        v.id,
        JSON.stringify(result.values),
        built.ok,
        built.summary,
        JSON.stringify(built.diagnostics),
        built.metrics ? JSON.stringify(built.metrics) : null,
        stlPath,
        pngPath,
        built.durationMs,
        configured,
      ],
    );

    return {
      buildHash: hash,
      ok: built.ok,
      cached: false,
      summary: built.summary,
      diagnostics: built.diagnostics,
      metrics: built.metrics,
      durationMs: built.durationMs,
      params: result.values,
      configured,
      stlUrl: stlPath ? `/api/builds/${hash}/model.stl` : null,
      previewUrl: pngPath ? `/api/builds/${hash}/preview.png` : null,
    };
  },
);

const ARTIFACTS = {
  "model.stl": { name: "stl", type: "model/stl" },
  "preview.png": { name: "png", type: "image/png" },
} as const;

app.get<{ Params: { hash: string; file: keyof typeof ARTIFACTS } }>(
  "/api/builds/:hash/:file",
  async (request, reply) => {
    const spec = ARTIFACTS[request.params.file];
    if (!spec) return reply.code(404).send({ error: "unknown artifact" });

    const data = await getArtifact(request.params.hash, spec.name).catch(() => null);
    if (!data) return reply.code(404).send({ error: "artifact not found" });

    if (spec.name === "stl") {
      await pool.query(
        "UPDATE builds SET download_count = download_count + 1 WHERE build_hash = $1",
        [request.params.hash],
      );
    }
    // Artifacts are content-addressed, so they can be cached indefinitely.
    return reply
      .header("content-type", spec.type)
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(data);
  },
);

/** Record proof of fabrication -- the platform's highest-value signal. */
app.post<{
  Params: { hash: string };
  Body: { machine?: string; material?: string; fitted?: boolean; notes?: string };
}>("/api/builds/:hash/made", async (request, reply) => {
  const { machine, material, fitted, notes } = request.body ?? {};
  if (typeof machine !== "string" || machine.trim() === "") {
    return reply.code(400).send({ error: "machine is required" });
  }
  if (typeof material !== "string" || material.trim() === "") {
    return reply.code(400).send({ error: "material is required" });
  }
  if (typeof fitted !== "boolean") {
    return reply.code(400).send({ error: "fitted must be true or false" });
  }

  const exists = await pool.query("SELECT 1 FROM builds WHERE build_hash = $1", [request.params.hash]);
  if (exists.rowCount === 0) return reply.code(404).send({ error: "no such build" });

  const { rows } = await pool.query(
    `INSERT INTO made_reports (build_hash, machine, material, fitted, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
    [request.params.hash, machine.trim(), material.trim(), fitted, (notes ?? "").trim()],
  );
  return reply.code(201).send(rows[0]);
});

/**
 * Search by fit: which parts mate with a given interface?
 * The query no existing site can answer, and the reason interfaces are rows.
 */
app.get<{ Querystring: { interface?: string; role?: string } }>(
  "/api/search/fit",
  async (request, reply) => {
    const iface = request.query.interface;
    if (!iface) return reply.code(400).send({ error: "interface is required" });
    const role = request.query.role;
    if (role !== undefined && role !== "implements" && role !== "consumes") {
      return reply.code(400).send({ error: "role must be implements or consumes" });
    }

    const { rows } = await pool.query(
      `SELECT DISTINCT u.handle, p.slug, p.title, p.summary, pi.role, v.version
         FROM part_interfaces pi
         JOIN interfaces i ON i.id = pi.interface_id
         JOIN part_versions v ON v.id = pi.part_version_id
         JOIN parts p ON p.id = v.part_id
         JOIN users u ON u.id = p.owner_id
        WHERE i.slug = $1 AND ($2::text IS NULL OR pi.role = $2)
        ORDER BY p.title`,
      [iface, role ?? null],
    );
    return { interface: iface, results: rows };
  },
);

app.get("/api/interfaces", async () => {
  const { rows } = await pool.query(
    `SELECT i.slug, i.name, i.description,
            count(*) FILTER (WHERE pi.role = 'implements') AS implementors,
            count(*) FILTER (WHERE pi.role = 'consumes')   AS consumers
       FROM interfaces i
       LEFT JOIN part_interfaces pi ON pi.interface_id = i.id
      GROUP BY i.id ORDER BY i.slug`,
  );
  return { interfaces: rows };
});

/** Parse a schema out of arbitrary source without publishing. Used by the publish flow. */
app.post<{ Body: { source?: unknown } }>("/api/schema/parse", async (request, reply) => {
  const source = request.body?.source;
  if (typeof source !== "string" || source.length === 0) {
    return reply.code(400).send({ error: "source is required" });
  }
  if (source.length > 1_000_000) return reply.code(413).send({ error: "source is too large" });
  return { schema: parseScad(source), sourceHash: hashSource(source) };
});

const start = async () => {
  try {
    const ran = await migrate();
    if (ran.length > 0) app.log.info({ migrations: ran }, "applied migrations");
    await app.listen({ port: PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();

export type { ParamValue };
