import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { findIncompleteness, parseDiagnostics, summarize, type Diagnostic } from "./diagnostics.js";
import { measure, parseStl, type MeshMetrics } from "./stl.js";

export interface BuildRequest {
  source: string;
  /** Pre-serialized `-D name=value` pairs from @datum/scad-schema. */
  args: string[];
  /** Additional files published with the part, for include/use resolution. */
  files?: Record<string, string>;
  /**
   * Where to place the entry source within the build directory, defaulting to
   * `main.scad`. OpenSCAD resolves `include <>` relative to the including file,
   * so a part whose entry lives in a subdirectory only resolves its siblings
   * correctly if the original layout is preserved.
   */
  entry?: string;
  /**
   * Directories within the part, relative to the build root, to put on
   * OPENSCADPATH. Many projects are written to be *installed* -- their examples
   * say `include <src/thing.scad>` or even `include <theproject/thing.scad>` and
   * expect the library to be on the search path rather than beside the file.
   * The supply audit found this to be the single most common cause of an
   * unresolved include, well ahead of genuinely third-party libraries.
   */
  searchPaths?: string[];
  renderPreview?: boolean;
  timeoutMs?: number;
}

export interface BuildArtifacts {
  stl?: Buffer;
  png?: Buffer;
}

export interface BuildResult {
  ok: boolean;
  /** One sentence suitable for showing directly to the person who triggered it. */
  summary: string;
  diagnostics: Diagnostic[];
  metrics?: MeshMetrics;
  artifacts: BuildArtifacts;
  durationMs: number;
  /** True when the build was killed for exceeding its time budget. */
  timedOut: boolean;
  /**
   * Set when OpenSCAD rendered *some* geometry but silently skipped part of the
   * model. Such a build is reported as a failure: publishing a half-model with a
   * healthy dimension report is exactly the quiet wrongness this exists to stop.
   */
  incomplete?: string[];
}

export interface RunnerOptions {
  openscadPath?: string;
  /** Wrap the invocation, e.g. ["xvfb-run", "-a"] for headless PNG rendering. */
  wrapper?: string[];
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
}

const DEFAULTS = {
  openscadPath: process.env.OPENSCAD_PATH ?? "openscad",
  wrapper: process.env.OPENSCAD_WRAPPER ? process.env.OPENSCAD_WRAPPER.split(" ") : [],
  defaultTimeoutMs: Number(process.env.BUILD_TIMEOUT_MS ?? 30_000),
  maxOutputBytes: Number(process.env.BUILD_MAX_OUTPUT_BYTES ?? 50 * 1024 * 1024),
  /** Vendored third-party libraries, always on the search path. */
  libraryDir: process.env.OPENSCAD_LIBRARY_DIR ?? "/opt/openscad-libraries",
} as const;

export class UnsafeFilenameError extends Error {}

/**
 * Resolve a published filename inside the build directory, or refuse.
 *
 * This is a containment check rather than a character whitelist. A whitelist
 * looked safer but was wrong twice over: it rejected the many real-world files
 * named like `Steady Rest.scad` or `Bracket (v2).scad`, and it reasoned about
 * spelling instead of about where the path actually lands. Resolving the path
 * and asserting it stays under the build root is both stricter and more
 * permissive in the right directions.
 */
export function safeJoin(dir: string, name: string): string {
  if (name === "" || name.includes("\0")) {
    throw new UnsafeFilenameError(`Refusing an empty or NUL-bearing filename`);
  }
  if (name.includes("\\")) {
    throw new UnsafeFilenameError(`Refusing a filename containing a backslash: ${name}`);
  }
  if (isAbsolute(name)) {
    throw new UnsafeFilenameError(`Refusing an absolute path: ${name}`);
  }

  const root = resolve(dir);
  const target = resolve(root, name);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new UnsafeFilenameError(`Refusing to write outside the build directory: ${name}`);
  }
  if (target === root) {
    throw new UnsafeFilenameError(`Refusing a filename that resolves to the build directory: ${name}`);
  }
  return target;
}

/**
 * Assemble OPENSCADPATH for a build: the build root first, then the part's
 * declared directories, then the vendored libraries. Nearest wins, so a part
 * can always shadow a library.
 *
 * A declared search path that escapes the build directory is ignored rather
 * than fatal; it is a hint from the caller, not part of the part's contents.
 */
export function assembleSearchPath(dir: string, searchPaths: string[], libraryDir: string): string {
  const searchDirs = [dir];
  for (const relative of searchPaths) {
    try {
      searchDirs.push(safeJoin(dir, relative));
    } catch {
      // ignored: see above
    }
  }
  searchDirs.push(libraryDir);
  return searchDirs.join(":");
}

interface SpawnOutcome {
  code: number | null;
  stderr: string;
  timedOut: boolean;
}

/**
 * Assemble the command line.
 *
 * Geometry export is headless, but PNG rendering needs an X display, so the
 * wrapper (xvfb-run) is applied only to previews. Wrapping every build would add
 * an X server startup to the hot path for no benefit.
 */
function commandFor(
  opts: { openscadPath: string; wrapper: readonly string[] },
  useWrapper: boolean,
  args: string[],
): { command: string; argv: string[] } {
  if (!useWrapper || opts.wrapper.length === 0) {
    return { command: opts.openscadPath, argv: args };
  }
  return {
    command: opts.wrapper[0]!,
    argv: [...opts.wrapper.slice(1), opts.openscadPath, ...args],
  };
}

function run(
  command: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  openscadPath?: string,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd,
      // A blank environment: the build gets no inherited credentials or config.
      // OPENSCADPATH is the one exception, and it only ever names directories
      // inside this build or the read-only vendored library tree.
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: cwd,
        TMPDIR: cwd,
        ...(openscadPath ? { OPENSCADPATH: openscadPath } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let timedOut = false;
    const cap = 256 * 1024;

    const collect = (chunk: Buffer) => {
      if (stderr.length < cap) stderr += chunk.toString("utf8");
    };
    child.stderr.on("data", collect);
    child.stdout.on("data", collect);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stderr: `${stderr}\nERROR: ${err.message}`, timedOut });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, timedOut });
    });
  });
}

async function readIfPresent(path: string, maxBytes: number): Promise<Buffer | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) return undefined;
    if (info.size > maxBytes) {
      throw new Error(
        `Output is ${(info.size / 1048576).toFixed(1)} MB, above the ${(maxBytes / 1048576).toFixed(0)} MB limit`,
      );
    }
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Compile a part.
 *
 * Isolation posture: each build gets a fresh directory, an environment stripped
 * of everything but PATH, a hard wall-clock timeout enforced with SIGKILL, and a
 * cap on output size. Network isolation and resource limits are enforced one
 * level up by the container (see the builder's compose service, which runs on an
 * internal network with no egress). Treat every submission as hostile.
 */
export async function build(request: BuildRequest, options: RunnerOptions = {}): Promise<BuildResult> {
  const opts = { ...DEFAULTS, ...options };
  const timeoutMs = request.timeoutMs ?? opts.defaultTimeoutMs;
  const started = Date.now();

  const dir = await mkdtemp(join(tmpdir(), "datum-build-"));
  try {
    const entry = request.entry ?? "main.scad";
    const mainPath = safeJoin(dir, entry);

    for (const [name, content] of Object.entries(request.files ?? {})) {
      if (name === entry) continue; // the entry comes from `source`
      const path = safeJoin(dir, name);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, content, "utf8");
    }

    await mkdir(join(mainPath, ".."), { recursive: true });
    await writeFile(mainPath, request.source, "utf8");

    const openscadPath = assembleSearchPath(dir, request.searchPaths ?? [], opts.libraryDir);

    const stlPath = join(dir, "out.stl");
    const stlCmd = commandFor(opts, false, ["-o", stlPath, ...request.args, mainPath]);
    const stlRun = await run(stlCmd.command, stlCmd.argv, dir, timeoutMs, openscadPath);

    const diagnostics = parseDiagnostics(stlRun.stderr);

    if (stlRun.timedOut) {
      return {
        ok: false,
        summary: `The build exceeded its ${Math.round(timeoutMs / 1000)} second time limit and was stopped.`,
        diagnostics,
        artifacts: {},
        durationMs: Date.now() - started,
        timedOut: true,
      };
    }

    const artifacts: BuildArtifacts = {};
    let metrics: MeshMetrics | undefined;

    try {
      const stl = await readIfPresent(stlPath, opts.maxOutputBytes);
      if (stl) {
        artifacts.stl = stl;
        metrics = measure(parseStl(stl));
      }
    } catch (err) {
      return {
        ok: false,
        summary: (err as Error).message,
        diagnostics,
        artifacts: {},
        durationMs: Date.now() - started,
        timedOut: false,
      };
    }

    if (stlRun.code !== 0 || !artifacts.stl) {
      return {
        ok: false,
        summary: summarize(
          diagnostics,
          stlRun.code === null
            ? "The build could not be started."
            : `OpenSCAD exited with status ${stlRun.code} and produced no geometry.`,
        ),
        diagnostics,
        artifacts,
        durationMs: Date.now() - started,
        timedOut: false,
      };
    }

    const incomplete = findIncompleteness(diagnostics);
    if (incomplete.length > 0) {
      return {
        ok: false,
        summary:
          `The build ran but produced an incomplete model: ${incomplete[0]}. ` +
          "Publish the missing file alongside the part, or add its directory to the part's search paths.",
        diagnostics,
        ...(metrics ? { metrics } : {}),
        artifacts,
        durationMs: Date.now() - started,
        timedOut: false,
        incomplete,
      };
    }

    if (metrics && metrics.triangleCount === 0) {
      return {
        ok: false,
        summary: "The build produced an empty model: these parameters generate no geometry.",
        diagnostics,
        metrics,
        artifacts,
        durationMs: Date.now() - started,
        timedOut: false,
      };
    }

    if (request.renderPreview) {
      const pngPath = join(dir, "out.png");
      const previewCmd = commandFor(opts, true, [
        "-o",
        pngPath,
        "--imgsize=1000,750",
        "--colorscheme=Tomorrow",
        "--autocenter",
        "--viewall",
        "--projection=perspective",
        ...request.args,
        mainPath,
      ]);
      const previewRun = await run(previewCmd.command, previewCmd.argv, dir, timeoutMs, openscadPath);
      // A failed preview is cosmetic: the geometry already built, so the build
      // still succeeds and the client falls back to rendering the STL itself.
      // It is recorded as a warning rather than swallowed, because a preview
      // pipeline that quietly stops working is exactly the kind of rot that goes
      // unnoticed for months.
      const png = previewRun.timedOut
        ? undefined
        : await readIfPresent(pngPath, opts.maxOutputBytes).catch(() => undefined);
      if (png) {
        artifacts.png = png;
      } else {
        diagnostics.push({
          level: "warning",
          raw: previewRun.timedOut
            ? "Preview render timed out"
            : `Preview render failed (status ${previewRun.code}): ${previewRun.stderr.trim().split("\n").pop() ?? "no output"}`,
          explanation: "The part built correctly but no preview image could be generated.",
        });
      }
    }

    return {
      ok: true,
      summary: "Build succeeded.",
      diagnostics,
      metrics,
      artifacts,
      durationMs: Date.now() - started,
      timedOut: false,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
