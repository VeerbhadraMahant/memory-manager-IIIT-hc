import type { Metadata } from "next";
import { Hanken_Grotesk, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// §1 type. Three families, three jobs, no overlap — JetBrains in particular is
// load-bearing: mono means "the machine generated this", so it carries
// timestamps, confidence values, STATED/INFERRED tags and status chips, and
// never a word of conversational content.
const hanken = Hanken_Grotesk({
  variable: "--font-hanken",
  subsets: ["latin"],
  // §3 font-loading: swap rather than block, so no invisible-text flash.
  display: "swap",
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Negotiated AI Memory",
  description: "Memory the user negotiates, rather than memory that accumulates silently.",
};

// The app is light everywhere (D45); there is no dark theme to switch to, so the
// colour-scheme is declared rather than inherited — otherwise the browser paints
// form controls and scrollbars for a dark page that does not exist.
export const viewport = {
  colorScheme: "light",
  // The one literal hex in the app, and unavoidable: browser chrome is painted
  // before any stylesheet, so this cannot read `var(--bg)`. It must be kept
  // equal to --bg in globals.css by hand.
  themeColor: "#F2F2F2",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${hanken.variable} ${inter.variable} ${jetbrains.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-bg text-ink-invert">
        {/* §6 / skip-links: the memory workspace sits behind a session nav and a
            transcript. Without this a keyboard user tabs the whole conversation
            to reach the list. */}
        <a
          href="#memory-workspace"
          className="sr-only rounded-input bg-surface px-4 py-3 text-body-sm font-medium text-ink focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
        >
          Skip to the memory workspace
        </a>
        {children}
      </body>
    </html>
  );
}
