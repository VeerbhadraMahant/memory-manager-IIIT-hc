"use client";

// Sign-in state for the whole app.
//
// The backend decides what is required (GET /auth/config), the frontend follows:
//
//   auth_required = false  -> render the app straight away; every request acts as the
//                             shared demo user (local dev, the hackathon demo).
//   Supabase configured    -> Supabase Auth with Google. supabase-js owns the session
//                             (PKCE, auto-refresh); each API call carries the current
//                             access token as a Bearer header.
//   Google configured      -> Google Identity Services. The ID token is exchanged for
//                             an HttpOnly session cookie, so JavaScript never holds a
//                             long-lived credential.
//
// Supabase wins when both are configured, but only if NEXT_PUBLIC_SUPABASE_ANON_KEY is
// set here too — the anon key is a public client key and the browser needs it. Without
// it the Google path is used if available, otherwise the sign-in screen says what is
// missing instead of failing silently.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";

import { api } from "@/lib/api";
import {
  setTokenSource,
  setUnauthorizedHandler,
  type AuthConfig,
  type AuthMode,
} from "@/lib/auth";

const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

type State =
  | { status: "loading" }
  | { status: "ready"; mode: AuthMode }
  | { status: "signed_out"; mode: Exclude<AuthMode, "none">; config: AuthConfig; error?: string }
  | { status: "misconfigured"; message: string };

export interface AuthContextValue {
  mode: AuthMode;
  /** True when a real account (not the shared demo user) is signed in. */
  canSignOut: boolean;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthContextValue>({
  mode: "none",
  canSignOut: false,
  signOut: async () => {},
});

export const useAuth = () => useContext(Ctx);

// The same-tab page reload that follows a Supabase OAuth redirect must not re-run the
// bootstrap twice under React strict mode; the client is created once per page load.
let supabaseClient: SupabaseClient | null = null;
async function getSupabase(url: string): Promise<SupabaseClient> {
  if (!supabaseClient) {
    // Dynamic import: nobody who is not using Supabase pays for it in their bundle.
    const { createClient } = await import("@supabase/supabase-js");
    supabaseClient = createClient(url, SUPABASE_ANON_KEY!, {
      auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }
  return supabaseClient;
}

function pickMode(cfg: AuthConfig): { mode: Exclude<AuthMode, "none"> | null; why?: string } {
  if (cfg.supabase_url && SUPABASE_ANON_KEY) return { mode: "supabase" };
  if (cfg.google_client_id) return { mode: "google" };
  if (cfg.supabase_url) {
    return {
      mode: null,
      why: "The backend uses Supabase Auth, but NEXT_PUBLIC_SUPABASE_ANON_KEY is not set for the frontend.",
    };
  }
  return { mode: null, why: "The backend requires sign-in but has no identity provider configured." };
}

export interface SignInScreenProps {
  mode: Exclude<AuthMode, "none">;
  config: AuthConfig;
  error?: string;
  onGoogleCredential: (credential: string) => Promise<void>;
  onSupabaseSignIn: () => Promise<void>;
}

export function AuthProvider({
  children,
  SignInScreen,
}: {
  children: ReactNode;
  /** Rendered while signed out. Injected so this module does not import UI. */
  SignInScreen: ComponentType<SignInScreenProps>;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const cfgRef = useRef<AuthConfig | null>(null);
  const modeRef = useRef<AuthMode>("none");

  const toSignedOut = useCallback((error?: string) => {
    const config = cfgRef.current;
    const mode = modeRef.current;
    if (!config || mode === "none") return;
    setState({ status: "signed_out", mode, config, error });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    (async () => {
      let cfg: AuthConfig;
      try {
        cfg = await api.authConfig();
      } catch {
        // Backend down, or an older backend with no /auth/config. Do not block on it:
        // the page's own boot reports "backend unreachable" far more usefully than a
        // blank gate would.
        if (!cancelled) setState({ status: "ready", mode: "none" });
        return;
      }
      if (cancelled) return;
      cfgRef.current = cfg;

      if (!cfg.auth_required) {
        setState({ status: "ready", mode: "none" });
        return;
      }

      const { mode, why } = pickMode(cfg);
      if (!mode) {
        setState({ status: "misconfigured", message: why! });
        return;
      }
      modeRef.current = mode;

      if (mode === "supabase") {
        const sb = await getSupabase(cfg.supabase_url!);
        setTokenSource(async () => (await sb.auth.getSession()).data.session?.access_token ?? null);
        const { data } = sb.auth.onAuthStateChange((_event, session) => {
          if (cancelled) return;
          if (session) setState({ status: "ready", mode: "supabase" });
          else toSignedOut();
        });
        unsubscribe = () => data.subscription.unsubscribe();
        const { data: s } = await sb.auth.getSession();
        if (cancelled) return;
        if (s.session) setState({ status: "ready", mode: "supabase" });
        else toSignedOut();
        return;
      }

      // Google: the session is a cookie we cannot inspect, so ask the backend.
      try {
        await api.me();
        if (!cancelled) setState({ status: "ready", mode: "google" });
      } catch {
        if (!cancelled) toSignedOut();
      }
    })();

    // Any 401 after sign-in (expired session, revoked user) returns to the sign-in
    // screen rather than leaving a half-working app that fails every click.
    setUnauthorizedHandler(() => {
      if (modeRef.current !== "none") toSignedOut("Your session expired — please sign in again.");
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
      setUnauthorizedHandler(null);
      setTokenSource(null);
    };
  }, [toSignedOut]);

  const onGoogleCredential = useCallback(
    async (credential: string) => {
      try {
        await api.googleSignIn(credential);
        setState({ status: "ready", mode: "google" });
      } catch (e) {
        toSignedOut(e instanceof Error ? e.message : "Sign-in failed.");
      }
    },
    [toSignedOut],
  );

  const onSupabaseSignIn = useCallback(async () => {
    const cfg = cfgRef.current;
    if (!cfg?.supabase_url) return;
    const sb = await getSupabase(cfg.supabase_url);
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) toSignedOut(error.message);
  }, [toSignedOut]);

  const signOut = useCallback(async () => {
    const mode = modeRef.current;
    if (mode === "supabase" && cfgRef.current?.supabase_url) {
      await (await getSupabase(cfgRef.current.supabase_url)).auth.signOut();
    } else if (mode === "google") {
      await api.signOutServer().catch(() => {});
      window.google?.accounts.id.disableAutoSelect();
      toSignedOut();
    }
  }, [toSignedOut]);

  const value = useMemo<AuthContextValue>(
    () => ({
      mode: state.status === "ready" ? state.mode : "none",
      canSignOut: state.status === "ready" && state.mode !== "none",
      signOut,
    }),
    [state, signOut],
  );

  if (state.status === "loading") {
    return (
      <div role="status" aria-live="polite" className="grid min-h-dvh place-items-center text-body-sm text-ink-invert-muted">
        Loading…
      </div>
    );
  }
  if (state.status === "misconfigured") {
    return (
      <div role="alert" className="mx-auto mt-16 max-w-md rounded-card border border-danger bg-danger-dim p-4 text-body-sm text-danger-on-bg">
        {state.message}
      </div>
    );
  }
  if (state.status === "signed_out") {
    return (
      <SignInScreen
        mode={state.mode}
        config={state.config}
        error={state.error}
        onGoogleCredential={onGoogleCredential}
        onSupabaseSignIn={onSupabaseSignIn}
      />
    );
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// Minimal typing for the slice of Google Identity Services this app touches.
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (cfg: {
            client_id: string;
            callback: (r: { credential: string }) => void;
            ux_mode?: "popup";
            auto_select?: boolean;
          }) => void;
          renderButton: (el: HTMLElement, opts: Record<string, string | number>) => void;
          disableAutoSelect: () => void;
        };
      };
    };
  }
}
