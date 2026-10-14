"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";

import { Logo } from "@/components/landing/Logo";
import { Button } from "@/components/ui/button";
import type { AuthConfig, AuthMode } from "@/lib/auth";

const GIS_SRC = "https://accounts.google.com/gsi/client";

/**
 * Shown when the backend requires sign-in and there is no session.
 *
 * One screen, two providers (see lib/auth-context.tsx for how one is chosen). The copy is the
 * product's own promise stated plainly: signing in is what makes the memory yours, so
 * the explanation is about what an account is for, not a legal preamble. It does not
 * promise export or deletion here — those live in the profile dialog, once you are in.
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
    <main className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <section aria-labelledby="signin-title" className="flex flex-col px-5 py-8 md:px-16">
        <Logo />
        <div className="my-auto w-full max-w-sm py-16">
          <h1 id="signin-title" className="text-headline-lg font-normal text-ink-invert">
            Sign in to your memory
          </h1>
          <p className="mt-4 text-body-md text-ink-invert-muted">
            Each account has its own memory. Nobody else can read it, and you decide what is kept,
            to which chat, and whether the model may see it.
          </p>

          {error && (
            <p
              role="alert"
              className="mt-6 rounded-input border border-danger bg-danger-dim px-3 py-2 text-body-sm text-danger-on-bg"
            >
              {error}
            </p>
          )}

          <div className="mt-8">
            {mode === "supabase" ? (
              <Button variant="primary" className="w-full" onClick={() => void onSupabaseSignIn()}>
                Continue with Google
              </Button>
            ) : (
              <GoogleButton clientId={config.google_client_id!} onCredential={onGoogleCredential} />
            )}
          </div>

          <Link
            href="/"
            className="tap mt-8 inline-flex items-center gap-1.5 text-body-sm text-accent hover:opacity-70"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to the overview
          </Link>
        </div>
      </section>

      {/* The one painted moment, again: the entry point shares the landing page's hero. */}
      <div className="relative hidden overflow-hidden bg-lavender lg:block" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/hero.svg" alt="" className="absolute inset-0 h-full w-full object-cover object-[78%_100%]" />
      </div>
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
