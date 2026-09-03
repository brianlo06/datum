import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fastify from "fastify";
import { librarySet } from "./libraries.js";
import { build as compile, UnsafeFilenameError } from "./openscad.js";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.BUILDER_PORT ?? 8081);
const MAX_SOURCE_BYTES = Number(process.env.BUILD_MAX_SOURCE_BYTES ?? 1024 * 1024);
/** Only one CAD process at a time per builder instance; scale by adding replicas. */
const MAX_CONCURRENT = Number(process.env.BUILD_CONCURRENCY ?? 2);

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  bodyLimit: 24 * 1024 * 1024,
});

let active = 0;

interface BuildBody {
  source?: unknown;
  args?: unknown;
  files?: unknown;
  entry?: unknown;
  searchPaths?: unknown;
  renderPreview?: unknown;
  timeoutMs?: unknown;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

app.get("/health", async () => {
  let version: string | null = null;
  try {
    const { stdout, stderr } = await execFileAsync(process.env.OPENSCAD_PATH ?? "openscad", [
      "--version",
    ]);
    // OpenSCAD prints its version to stderr on some builds.
    version = (stdout || stderr).trim() || null;
  } catch {
    version = null;
  }
  const libs = await librarySet();
  return {
    ok: version !== null,
    kernel: "openscad",
    version,
    active,
    maxConcurrent: MAX_CONCURRENT,
    // The API needs this digest to keep the build cache honest across library bumps.
    libraryDigest: libs.digest,
    libraries: libs.libraries.map((l) => ({
      name: l.name,
      version: l.version,
      license: l.license,
      include: l.include,
    })),
  };
});

app.post("/build", async (request, reply) => {
  const body = (request.body ?? {}) as BuildBody;

  if (typeof body.source !== "string" || body.source.length === 0) {
    return reply.code(400).send({ error: "source is required" });
  }
  if (Buffer.byteLength(body.source, "utf8") > MAX_SOURCE_BYTES) {
    return reply.code(413).send({ error: `source exceeds ${MAX_SOURCE_BYTES} bytes` });
  }
  if (body.args !== undefined && !isStringArray(body.args)) {
    return reply.code(400).send({ error: "args must be an array of strings" });
  }
  if (body.entry !== undefined && typeof body.entry !== "string") {
    return reply.code(400).send({ error: "entry must be a string" });
  }
  if (body.searchPaths !== undefined && !isStringArray(body.searchPaths)) {
    return reply.code(400).send({ error: "searchPaths must be an array of strings" });
  }

  let files: Record<string, string> | undefined;
  if (body.files !== undefined) {
    if (typeof body.files !== "object" || body.files === null || Array.isArray(body.files)) {
      return reply.code(400).send({ error: "files must be an object of name to contents" });
    }
    files = {};
    for (const [name, content] of Object.entries(body.files as Record<string, unknown>)) {
      if (typeof content !== "string") {
        return reply.code(400).send({ error: `file ${name} must be a string` });
      }
      files[name] = content;
    }
  }

  if (active >= MAX_CONCURRENT) {
    return reply.code(503).header("retry-after", "2").send({ error: "builder is busy" });
  }

  active++;
  try {
    const result = await compile({
      source: body.source,
      args: (body.args as string[] | undefined) ?? [],
      ...(files ? { files } : {}),
      ...(typeof body.entry === "string" ? { entry: body.entry } : {}),
      ...(isStringArray(body.searchPaths) ? { searchPaths: body.searchPaths } : {}),
      renderPreview: body.renderPreview === true,
      ...(typeof body.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {}),
    });

    return reply.send({
      ok: result.ok,
      summary: result.summary,
      diagnostics: result.diagnostics,
      metrics: result.metrics ?? null,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      artifacts: {
        stl: result.artifacts.stl ? result.artifacts.stl.toString("base64") : null,
        png: result.artifacts.png ? result.artifacts.png.toString("base64") : null,
      },
    });
  } catch (err) {
    if (err instanceof UnsafeFilenameError) {
      return reply.code(400).send({ error: err.message });
    }
    request.log.error({ err }, "build failed");
    return reply.code(500).send({ error: "build failed unexpectedly" });
  } finally {
    active--;
  }
});

const start = async () => {
  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
