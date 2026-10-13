// Auth plumbing that api.ts needs and React does not.
//
// Deliberately framework-free and import-free: lib/api.ts imports this, and the
// provider in lib/auth-context.tsx imports lib/api.ts, so anything here that imported either
// would be a cycle. The provider registers a token source and a 401 handler at runtime;
// api.ts only ever calls the functions below.

export type AuthMode = "none" | "supabase" | "google";

/** Mirrors GET /auth/config. Contains no secrets: the Google client id and the
 *  Supabase URL are public by design. */
export interface AuthConfig {
  auth_required: boolean;
  google_client_id: string | null;
  supabase_url: string | null;
  session_cookie: string;
}

let tokenSource: (() => Promise<string | null>) | null = null;
let unauthorizedHandler: (() => void) | null = null;

/** Supabase mode registers one. Google mode does not: its session is an HttpOnly
 *  cookie the browser attaches itself, so there is no token in JavaScript to steal. */
export function setTokenSource(fn: (() => Promise<string | null>) | null) {
  tokenSource = fn;
}

export function setUnauthorizedHandler(fn: (() => void) | null) {
  unauthorizedHandler = fn;
}

export async function getAccessToken(): Promise<string | null> {
  if (!tokenSource) return null;
  try {
    return await tokenSource();
  } catch {
    return null;
  }
}

export function notifyUnauthorized() {
  unauthorizedHandler?.();
}
