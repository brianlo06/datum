import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Artifact storage.
 *
 * Compiled geometry is *derived*, never uploaded -- the source is authoritative,
 * so anything here can be regenerated and is safe to evict. That is what keeps
 * storage from becoming the cost centre the brief warns about. Files are sharded
 * by hash prefix to keep directory sizes sane.
 */

const ROOT = process.env.ARTIFACT_DIR ?? join(process.cwd(), "var", "artifacts");

const HASH = /^[0-9a-f]{64}$/;

export class BadArtifactKey extends Error {}

function pathFor(buildHash: string, name: string): string {
  if (!HASH.test(buildHash)) throw new BadArtifactKey(`Invalid build hash: ${buildHash}`);
  if (!/^[a-z0-9.]+$/.test(name)) throw new BadArtifactKey(`Invalid artifact name: ${name}`);
  return join(ROOT, buildHash.slice(0, 2), buildHash.slice(2, 4), `${buildHash}.${name}`);
}

export async function put(buildHash: string, name: string, data: Buffer): Promise<string> {
  const path = pathFor(buildHash, name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, data);
  return path;
}

export async function get(buildHash: string, name: string): Promise<Buffer | null> {
  try {
    return await readFile(pathFor(buildHash, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
