import { AuthGate } from "@/components/AuthGate";

// Everything behind sign-in. The landing page (app/page.tsx) is outside this group on
// purpose: it is public, and putting the auth gate in the root layout would make a
// visitor see a sign-in wall before they could read what the product is.
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* §6 / skip-links: the memory workspace sits behind a session nav and a
          transcript. Without this a keyboard user tabs the whole conversation
          to reach the list. */}
      <a
        href="#memory-workspace"
        className="sr-only rounded-input bg-surface px-4 py-3 text-body-sm font-medium text-ink focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
      >
        Skip to the memory workspace
      </a>
      <AuthGate>{children}</AuthGate>
    </>
  );
}
