"use client";

import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import type { AuthConfig, AuthMode } from "@/lib/auth";

const GIS_SRC = "https://accounts.google.com/gsi/client";

/**
 * Shown when the backend requires sign-in and there is no session.
 *
 * One screen, two providers (see lib/auth-context.tsx for how one is chosen). The copy is the
 * product's own promise stated plainly: signing in is what makes the memory yours, so
 * the explanation is about what an account is for, not a legal preamble.
 */
export function SignIn({
  mode,
  config,
  error,
  onGoogleCredential,
  onSupabaseSignIn,
}: {
  mode: Exclude<AuthMode, "none">;
  config: AuthConfig;
  error?: string;
  onGoogleCredential: (credential: string) => Promise<void>;
  onSupabaseSignIn: () => Promise<void>;
}) {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <section
        aria-labelledby="signin-title"
        className="w-full max-w-sm rounded-card bg-surface p-6 text-ink shadow-[0_1px_2px_rgb(15_20_25/0.06)]"
      >
        <h1 id="signin-title" className="text-title-md font-semibold">
          Negotiated AI Memory
        </h1>
        <p className="mt-2 text-body-sm text-ink-muted">
          Sign in so your memories stay yours. Each account has its own memory — nobody
          else can read it, and you can export or delete all of it from your profile.
        </p>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-input border border-danger bg-danger-dim px-3 py-2 text-body-sm text-danger-ink"
          >
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-center">
          {mode === "supabase" ? (
            <Button variant="primary" className="w-full" onClick={() => void onSupabaseSignIn()}>
              Continue with Google
            </Button>
          ) : (
            <GoogleButton clientId={config.google_client_id!} onCredential={onGoogleCredential} />
          )}
        </div>
      </section>
    </main>
  );
}

/** Google's own rendered button — their branding rules require it, and it is what
 *  produces the ID token the backend verifies. */
function GoogleButton({
  clientId,
  onCredential,
}: {
  clientId: string;
  onCredential: (credential: string) => Promise<void>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const callback = useRef(onCredential);
  useEffect(() => {
    callback.current = onCredential;
  }, [onCredential]);

  useEffect(() => {
    const render = () => {
      if (!host.current || !window.google) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (r) => void callback.current(r.credential),
        ux_mode: "popup",
      });
      window.google.accounts.id.renderButton(host.current, {
        theme: "outline",
        size: "large",
        text: "continue_with",
        shape: "rectangular",
        width: 280,
      });
    };

    if (window.google) {
      render();
      return;
    }
    let script = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = GIS_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", render);
    return () => script?.removeEventListener("load", render);
  }, [clientId]);

  return <div ref={host} aria-label="Sign in with Google" />;
}
