"use client";

// Client boundary for auth. layout.tsx is a server component and cannot hand a render
// function to a client component, so the sign-in screen is wired here.

import type { ReactNode } from "react";

import { SignIn } from "@/components/SignIn";
import { AuthProvider } from "@/lib/auth-context";

export function AuthGate({ children }: { children: ReactNode }) {
  return <AuthProvider SignInScreen={SignIn}>{children}</AuthProvider>;
}
