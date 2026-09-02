import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  buildHash as computeBuildHash,
  diffSchemas,
  hashSource,
  parseScad,
  toArgs,
  validate,
  type ScadSchema,
} from "@datum/scad-schema";
import { put as putArtifact } from "./artifacts.js";
import { AuthError, createAuthor, isHandle, requireAuthor } from "./auth.js";
import { BuilderBusy, BuilderUnavailable, runBuild, type BuilderResponse } from "./builder.js";
import { pool, withTransaction } from "./db.js";
import { isLicense, LICENSES } from "./licenses.js";
import { evaluateReadiness, type Readiness } from "./readiness.js";
import { checkChosenVersion, proposeBump, type BumpProposal, type GeometrySummary } from "./versioning.js";

const MAX_SOURCE_BYTES = 1_000_000;
const MAX_FILES = 20;
const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SAFE_FILENAME = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

interface Preflight {
  schema: ScadSchema;
  sourceHash: string;
  build: BuilderResponse;
  readiness: Readiness;
}

/**
 * Parse, build and grade a candidate part without storing anything.
 *
 * Publishing re-runs this server-side rather than trusting whatever the client
 * says preflight returned. The duplicated compile is the price of not letting a
 * caller assert its own readiness.
 */
async function preflight(source: string, files?: Record<string, string>): Promise<Preflight> {
  const schema = parseScad(source);
  const { values } = validate(schema, {});
  const build = await runBuild({
    source,
    args: toArgs(schema, values),
    ...(files ? { files } : {}),
    renderPreview: true,
  });
  const readiness = evaluateReadiness(schema, {
    ok: build.ok,
    summary: build.summary,
    metrics: build.metrics,
  });
  return { schema, sourceHash: hashSource(source), build, readiness };
}

function geometryOf(build: BuilderResponse): GeometrySummary | null {
  if (!build.metrics) return null;
  return {
    boundingBox: { size: build.metrics.boundingBox.size },
    volumeMm3: build.metrics.volumeMm3,
    solid: build.metrics.solid,
  };
}

/** Validate the source/files payload shared by every publish entry point. */
function readSource(
  body: { source?: unknown; files?: unknown },
  reply: FastifyReply,
): { source: string; files?: Record<string, string> } | null {
  if (typeof body.source !== "string" || body.source.trim() === "") {
    reply.code(400).send({ error: "source is required" });
    return null;
  }
  if (Buffer.byteLength(body.source, "utf8") > MAX_SOURCE_BYTES) {
    reply.code(413).send({ error: "source is larger than 1 MB" });
    return null;
  }

  if (body.files === undefined) return { source: body.source };

  if (typeof body.files !== "object" || body.files === null || Array.isArray(body.files)) {
    reply.code(400).send({ error: "files must be an object mapping filename to contents" });
    return null;
  }
  const entries = Object.entries(body.files as Record<string, unknown>);
  if (entries.length > MAX_FILES) {
    reply.code(413).send({ error: `a part may include at most ${MAX_FILES} extra files` });
    return null;
  }
  const files: Record<string, string> = {};
  for (const [name, content] of entries) {
    if (!SAFE_FILENAME.test(name) || name.split("/").includes("..")) {
      reply.code(400).send({ error: `unsafe filename: ${name}` });
      return null;
    }
    if (typeof content !== "string") {
      reply.code(400).send({ error: `file ${name} must be text` });
      return null;
    }
    if (Buffer.byteLength(content, "utf8") > MAX_SOURCE_BYTES) {
      reply.code(413).send({ error: `file ${name} is larger than 1 MB` });
      return null;
    }
    files[name] = content;
  }
  return { source: body.source, files };
}

interface InterfaceClaim {
  slug: string;
  role: "implements" | "consumes";
}

async function readInterfaces(
  raw: unknown,
  reply: FastifyReply,
): Promise<InterfaceClaim[] | null> {
  if (!Array.isArray(raw) || raw.length === 0) {
    reply.code(400).send({
      error:
        "Declare at least one interface. It is how people find this part by fit, " +
        "and it is what makes the registry more than a file host.",
    });
    return null;
  }
  const claims: InterfaceClaim[] = [];
  for (const item of raw) {
    const entry = item as { slug?: unknown; role?: unknown };
    if (typeof entry.slug !== "string") {
      reply.code(400).send({ error: "each interface needs a slug" });
      return null;
    }
    if (entry.role !== "implements" && entry.role !== "consumes") {
      reply.code(400).send({ error: `interface ${entry.slug}: role must be implements or consumes` });
      return null;
    }
    claims.push({ slug: entry.slug, role: entry.role });
  }

  const { rows } = await pool.query<{ slug: string }>(
    "SELECT slug FROM interfaces WHERE slug = ANY($1::text[])",
    [claims.map((c) => c.slug)],
  );
  const known = new Set(rows.map((r) => r.slug));
  const unknown = claims.filter((c) => !known.has(c.slug)).map((c) => c.slug);
  if (unknown.length > 0) {
    reply.code(400).send({
      error: `Unknown interface(s): ${unknown.join(", ")}. Pick from the published vocabulary.`,
    });
    return null;
  }
  return claims;
}

/** Persist a build produced during publishing, attached to a version. */
async function recordBuild(
  client: Parameters<Parameters<typeof withTransaction>[0]>[0],
  versionId: string,
  sourceHash: string,
  schema: ScadSchema,
  build: BuilderResponse,
): Promise<string> {
  const { values } = validate(schema, {});
  const hash = computeBuildHash(sourceHash, values);

  let stlPath: string | null = null;
  let pngPath: string | null = null;
  if (build.artifacts.stl) stlPath = await putArtifact(hash, "stl", Buffer.from(build.artifacts.stl, "base64"));
  if (build.artifacts.png) pngPath = await putArtifact(hash, "png", Buffer.from(build.artifacts.png, "base64"));

  await client.query(
    `INSERT INTO builds (build_hash, part_version_id, params, ok, summary, diagnostics,
                         metrics, stl_path, png_path, duration_ms, configured)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false)
     ON CONFLICT (build_hash) DO UPDATE SET part_version_id = EXCLUDED.part_version_id`,
    [
      hash,
      versionId,
      JSON.stringify(values),
      build.ok,
      build.summary,
      JSON.stringify(build.diagnostics),
      build.metrics ? JSON.stringify(build.metrics) : null,
      stlPath,
      pngPath,
      build.durationMs,
    ],
  );
  await client.query("UPDATE part_versions SET default_build_hash = $1 WHERE id = $2", [hash, versionId]);
  return hash;
}

async function setInterfaces(
  client: Parameters<Parameters<typeof withTransaction>[0]>[0],
  versionId: string,
  claims: InterfaceClaim[],
): Promise<void> {
  for (const claim of claims) {
    await client.query(
      `INSERT INTO part_interfaces (part_version_id, interface_id, role)
       SELECT $1, i.id, $2 FROM interfaces i WHERE i.slug = $3
       ON CONFLICT DO NOTHING`,
      [versionId, claim.role, claim.slug],
    );
  }
}

/** Strip artifacts before returning a build to the client; they go by URL. */
function publicBuild(build: BuilderResponse) {
  return {
    ok: build.ok,
    summary: build.summary,
    diagnostics: build.diagnostics,
    metrics: build.metrics,
    durationMs: build.durationMs,
    // Preflight has nowhere to store artifacts yet, so the preview is inlined.
    previewBase64: build.artifacts.png,
  };
}

export const publishRoutes: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof BuilderBusy) {
      return reply.code(503).header("retry-after", "3").send({ error: "builders are busy, retry shortly" });
    }
    if (err instanceof BuilderUnavailable) {
      return reply.code(502).send({ error: "the build service is unavailable" });
    }
    app.log.error({ err }, "unhandled error in publish routes");
    return reply.code(500).send({ error: "something went wrong" });
  });

  app.get("/api/licenses", async () => ({ licenses: LICENSES }));

  app.post<{ Body: { handle?: unknown; displayName?: unknown } }>(
    "/api/authors",
    async (request, reply) => {
      const { handle, displayName } = request.body ?? {};
      if (!isHandle(handle)) {
        return reply.code(400).send({
          error: "A handle must be 2-39 characters: lowercase letters, digits and hyphens.",
        });
      }
      const name = typeof displayName === "string" && displayName.trim() !== "" ? displayName.trim() : handle;
      const { author, token } = await createAuthor(handle, name);
      return reply.code(201).send({
        handle: author.handle,
        displayName: author.displayName,
        token,
        notice: "Save this token now. It is shown once and cannot be recovered.",
      });
    },
  );

  /** Grade a candidate part without storing anything. */
  app.post<{ Body: { source?: unknown; files?: unknown } }>(
    "/api/publish/preflight",
    async (request, reply) => {
      const input = readSource(request.body ?? {}, reply);
      if (!input) return reply;

      const result = await preflight(input.source, input.files);
      return reply.send({
        schema: result.schema,
        sourceHash: result.sourceHash,
        build: publicBuild(result.build),
        readiness: result.readiness,
      });
    },
  );

  /** Publish a new part at 1.0.0. */
  app.post<{
    Body: {
      slug?: unknown;
      title?: unknown;
      summary?: unknown;
      license?: unknown;
      interfaces?: unknown;
      source?: unknown;
      files?: unknown;
      notes?: unknown;
    };
  }>("/api/parts", async (request, reply) => {
    const author = await requireAuthor(request);
    const body = request.body ?? {};

    if (typeof body.slug !== "string" || !SLUG.test(body.slug)) {
      return reply.code(400).send({
        error: "A slug must be 2-64 characters: lowercase letters, digits and hyphens.",
      });
    }
    if (typeof body.title !== "string" || body.title.trim() === "") {
      return reply.code(400).send({ error: "title is required" });
    }
    if (!isLicense(body.license)) {
      return reply.code(400).send({
        error: "Choose a licence from the published list. Licensing is not a free-text field.",
      });
    }

    const input = readSource(body, reply);
    if (!input) return reply;
    const claims = await readInterfaces(body.interfaces, reply);
    if (!claims) return reply;

    const existing = await pool.query("SELECT 1 FROM parts WHERE owner_id = $1 AND slug = $2", [
      author.id,
      body.slug,
    ]);
    if ((existing.rowCount ?? 0) > 0) {
      return reply.code(409).send({ error: `You already have a part called "${body.slug}".` });
    }

    const result = await preflight(input.source, input.files);
    if (!result.readiness.ready) {
      return reply.code(422).send({
        error: "This part is not ready to publish.",
        blockers: result.readiness.blockers,
        readiness: result.readiness,
        build: publicBuild(result.build),
      });
    }

    const published = await withTransaction(async (client) => {
      const { rows: partRows } = await client.query<{ id: string }>(
        `INSERT INTO parts (owner_id, slug, title, summary, license)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [author.id, body.slug, (body.title as string).trim(), typeof body.summary === "string" ? body.summary.trim() : "", body.license],
      );
      const partId = partRows[0]!.id;

      const { rows: versionRows } = await client.query<{ id: string }>(
        `INSERT INTO part_versions (part_id, version, source, source_hash, schema, files, notes)
         VALUES ($1,'1.0.0',$2,$3,$4,$5,$6) RETURNING id`,
        [
          partId,
          input.source,
          result.sourceHash,
          JSON.stringify(result.schema),
          JSON.stringify(input.files ?? {}),
          typeof body.notes === "string" ? body.notes.trim() : "Initial release.",
        ],
      );
      const versionId = versionRows[0]!.id;

      await setInterfaces(client, versionId, claims);
      const buildHash = await recordBuild(client, versionId, result.sourceHash, result.schema, result.build);
      return { partId, versionId, buildHash };
    });

    return reply.code(201).send({
      owner: author.handle,
      slug: body.slug,
      version: "1.0.0",
      url: `/api/parts/${author.handle}/${body.slug}`,
      buildHash: published.buildHash,
      readiness: result.readiness,
    });
  });

  /**
   * Ask what the next version should be. Returns the proposal and the readiness
   * report without publishing anything.
   */
  app.post<{ Params: { owner: string; slug: string }; Body: { source?: unknown; files?: unknown } }>(
    "/api/parts/:owner/:slug/versions/propose",
    async (request, reply) => {
      const author = await requireAuthor(request);
      const current = await loadOwnedLatest(request.params.owner, request.params.slug, author.id, reply);
      if (!current) return reply;

      const input = readSource(request.body ?? {}, reply);
      if (!input) return reply;

      const result = await preflight(input.source, input.files);
      const proposal = buildProposal(current, result);
      return reply.send({
        proposal,
        readiness: result.readiness,
        schema: result.schema,
        build: publicBuild(result.build),
        unchanged: result.sourceHash === current.sourceHash,
      });
    },
  );

  /** Publish a new version of an existing part. */
  app.post<{
    Params: { owner: string; slug: string };
    Body: { source?: unknown; files?: unknown; version?: unknown; notes?: unknown; interfaces?: unknown };
  }>("/api/parts/:owner/:slug/versions", async (request, reply) => {
    const author = await requireAuthor(request);
    const current = await loadOwnedLatest(request.params.owner, request.params.slug, author.id, reply);
    if (!current) return reply;

    const body = request.body ?? {};
    const input = readSource(body, reply);
    if (!input) return reply;

    if (typeof body.version !== "string") {
      return reply.code(400).send({ error: "version is required; call /versions/propose first" });
    }

    const result = await preflight(input.source, input.files);
    if (!result.readiness.ready) {
      return reply.code(422).send({
        error: "This revision is not ready to publish.",
        blockers: result.readiness.blockers,
        readiness: result.readiness,
        build: publicBuild(result.build),
      });
    }

    const proposal = buildProposal(current, result);
    const verdict = checkChosenVersion(body.version, proposal);
    if (!verdict.ok) {
      return reply.code(422).send({ error: verdict.message, proposal });
    }

    // Interfaces carry forward unless the author restates them.
    let claims: InterfaceClaim[];
    if (body.interfaces === undefined) {
      claims = current.interfaces;
    } else {
      const parsed = await readInterfaces(body.interfaces, reply);
      if (!parsed) return reply;
      claims = parsed;
    }

    const published = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO part_versions (part_id, version, source, source_hash, schema, files, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          current.partId,
          body.version,
          input.source,
          result.sourceHash,
          JSON.stringify(result.schema),
          JSON.stringify(input.files ?? {}),
          typeof body.notes === "string" ? body.notes.trim() : "",
        ],
      );
      const versionId = rows[0]!.id;
      await setInterfaces(client, versionId, claims);
      const buildHash = await recordBuild(client, versionId, result.sourceHash, result.schema, result.build);
      await client.query("UPDATE parts SET updated_at = now() WHERE id = $1", [current.partId]);
      return { versionId, buildHash };
    });

    return reply.code(201).send({
      owner: request.params.owner,
      slug: request.params.slug,
      version: body.version,
      previousVersion: current.version,
      bump: proposal.bump,
      buildHash: published.buildHash,
      url: `/api/parts/${request.params.owner}/${request.params.slug}`,
    });
  });
};

interface CurrentVersion {
  partId: string;
  versionId: string;
  version: string;
  sourceHash: string;
  schema: ScadSchema;
  interfaces: InterfaceClaim[];
  geometry: GeometrySummary | null;
}

function buildProposal(current: CurrentVersion, next: Preflight): BumpProposal {
  return proposeBump(
    current.version,
    diffSchemas(current.schema, next.schema),
    current.geometry,
    geometryOf(next.build),
  );
}

/** Load the latest version of a part, checking the caller owns it. */
async function loadOwnedLatest(
  owner: string,
  slug: string,
  authorId: string,
  reply: FastifyReply,
): Promise<CurrentVersion | null> {
  const { rows } = await pool.query<{
    part_id: string;
    owner_id: string;
    version_id: string;
    version: string;
    source_hash: string;
    schema: ScadSchema;
    metrics: GeometrySummary | null;
  }>(
    `SELECT p.id AS part_id, p.owner_id, v.id AS version_id, v.version, v.source_hash, v.schema,
            b.metrics
       FROM part_versions v
       JOIN parts p ON p.id = v.part_id
       JOIN users u ON u.id = p.owner_id
       LEFT JOIN builds b ON b.build_hash = v.default_build_hash
      WHERE u.handle = $1 AND p.slug = $2
      ORDER BY v.created_at DESC
      LIMIT 1`,
    [owner, slug],
  );

  const row = rows[0];
  if (!row) {
    reply.code(404).send({ error: "part not found" });
    return null;
  }
  if (row.owner_id !== authorId) {
    reply.code(403).send({ error: `This part belongs to ${owner}. You can fork it instead.` });
    return null;
  }

  const { rows: ifaceRows } = await pool.query<{ slug: string; role: "implements" | "consumes" }>(
    `SELECT i.slug, pi.role FROM part_interfaces pi
       JOIN interfaces i ON i.id = pi.interface_id
      WHERE pi.part_version_id = $1`,
    [row.version_id],
  );

  return {
    partId: row.part_id,
    versionId: row.version_id,
    version: row.version,
    sourceHash: row.source_hash,
    schema: row.schema,
    interfaces: ifaceRows,
    geometry: row.metrics,
  };
}
