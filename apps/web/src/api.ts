import type {
  BuildResult,
  Interface,
  License,
  PartDetail,
  PartSummary,
  Preflight,
  ProposeResult,
  PublishedPart,
  ParamValue,
} from "./types";

const TOKEN_KEY = "datum.token";
const HANDLE_KEY = "datum.handle";

/**
 * The publish token lives in localStorage because there is no session system
 * yet. It is minted once and never recoverable, so the UI has to say so clearly
 * wherever it is shown.
 */
export const identity = {
  get(): { handle: string; token: string } | null {
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const handle = localStorage.getItem(HANDLE_KEY);
      return token && handle ? { handle, token } : null;
    } catch {
      return null; // private browsing, blocked storage
    }
  },
  set(handle: string, token: string) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(HANDLE_KEY, handle);
    } catch {
      /* the session still works, it just will not survive a reload */
    }
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(HANDLE_KEY);
    } catch {
      /* nothing to do */
    }
  },
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit & { auth?: boolean }): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body) headers["content-type"] = "application/json";
  if (init?.auth) {
    const id = identity.get();
    if (!id) throw new ApiError("You need a handle before you can publish.", 401, {});
    headers.authorization = `Bearer ${id.token}`;
  }

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError("Could not reach the server.", 0, {});
  }

  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { error: text.slice(0, 300) };
    }
  }

  if (!res.ok) {
    throw new ApiError(
      typeof body.error === "string" ? body.error : `Request failed (HTTP ${res.status}).`,
      res.status,
      body,
    );
  }
  return body as T;
}

export const api = {
  parts: () => request<{ parts: PartSummary[] }>("/api/parts"),
  part: (owner: string, slug: string) => request<PartDetail>(`/api/parts/${owner}/${slug}`),
  build: (owner: string, slug: string, params: Record<string, ParamValue>) =>
    request<BuildResult>(`/api/parts/${owner}/${slug}/build`, {
      method: "POST",
      body: JSON.stringify({ params }),
    }),
  licenses: () => request<{ licenses: License[] }>("/api/licenses"),
  interfaces: () => request<{ interfaces: Interface[] }>("/api/interfaces"),
  preflight: (source: string, files?: Record<string, string>) =>
    request<Preflight>("/api/publish/preflight", {
      method: "POST",
      body: JSON.stringify({ source, ...(files ? { files } : {}) }),
    }),
  claimHandle: (handle: string, displayName: string) =>
    request<{ handle: string; token: string; notice: string }>("/api/authors", {
      method: "POST",
      body: JSON.stringify({ handle, displayName }),
    }),
  publish: (input: {
    slug: string;
    title: string;
    summary: string;
    license: string;
    interfaces: { slug: string; role: string }[];
    source: string;
    files?: Record<string, string>;
    notes?: string;
  }) =>
    request<PublishedPart>("/api/parts", {
      method: "POST",
      auth: true,
      body: JSON.stringify(input),
    }),
  proposeVersion: (owner: string, slug: string, source: string, files?: Record<string, string>) =>
    request<ProposeResult>(`/api/parts/${owner}/${slug}/versions/propose`, {
      method: "POST",
      auth: true,
      body: JSON.stringify({ source, ...(files ? { files } : {}) }),
    }),
  publishVersion: (
    owner: string,
    slug: string,
    input: { source: string; version: string; notes?: string; files?: Record<string, string> },
  ) =>
    request<{ version: string; previousVersion: string; bump: string }>(
      `/api/parts/${owner}/${slug}/versions`,
      { method: "POST", auth: true, body: JSON.stringify(input) },
    ),
};
