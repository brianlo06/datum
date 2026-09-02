import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { pool } from "./db.js";

/**
 * Minimal ownership.
 *
 * This is NOT an account system and should not be mistaken for one: no email, no
 * password, no recovery, no sessions. Claiming a handle mints a token once;
 * publishing to that handle requires presenting it. That is enough to stop one
 * author publishing under another's name during development, and no more.
 *
 * Replace before anything is exposed publicly. The brief's trust-and-safety
 * section (ownership disputes, DMCA, moderation) all assumes real identities.
 */

export interface Author {
  id: string;
  handle: string;
  displayName: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const HANDLE = /^[a-z0-9][a-z0-9-]{1,38}$/;

export function isHandle(value: unknown): value is string {
  return typeof value === "string" && HANDLE.test(value);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Claim a handle. Returns the token exactly once; only its hash is stored. */
export async function createAuthor(
  handle: string,
  displayName: string,
): Promise<{ author: Author; token: string }> {
  const token = randomBytes(24).toString("base64url");
  const { rows } = await pool.query<{ id: string; handle: string; display_name: string }>(
    `INSERT INTO users (handle, display_name, publish_token_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (handle) DO NOTHING
     RETURNING id, handle, display_name`,
    [handle, displayName, hashToken(token)],
  );

  if (rows.length === 0) {
    throw new AuthError(`The handle "${handle}" is already taken.`, 409);
  }
  const row = rows[0]!;
  return { author: { id: row.id, handle: row.handle, displayName: row.display_name }, token };
}

/** Resolve the bearer token on a request to an author, or throw. */
export async function requireAuthor(request: FastifyRequest): Promise<Author> {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new AuthError("A publish token is required. Claim a handle first.", 401);
  }
  const token = header.slice(7).trim();
  if (token.length === 0) throw new AuthError("The publish token is empty.", 401);

  const { rows } = await pool.query<{ id: string; handle: string; display_name: string; publish_token_hash: string }>(
    "SELECT id, handle, display_name, publish_token_hash FROM users WHERE publish_token_hash = $1",
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) throw new AuthError("That publish token is not recognised.", 401);

  // The lookup above is already by hash, so this is belt-and-braces against a
  // future change that fetches by handle instead.
  const a = Buffer.from(row.publish_token_hash);
  const b = Buffer.from(hashToken(token));
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthError("That publish token is not recognised.", 401);
  }

  return { id: row.id, handle: row.handle, displayName: row.display_name };
}
