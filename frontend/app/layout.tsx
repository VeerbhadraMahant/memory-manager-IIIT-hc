import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Source_Serif_4 } from "next/font/google";
import "./globals.css";

// §1 type. Source Serif 4 at weight 400 is the display voice (h1/h2); Inter carries all UI
// copy. JetBrains Mono means "the machine generated this" and never carries conversational
// content. (Steep's Signifier / Söhne are commercial; these are the style's named fallbacks.)
const serif = Source_Serif_4({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
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

// The app is light everywhere (Steep); there is no dark theme to switch to, so the
// colour-scheme is declared rather than inherited — otherwise the browser paints
// form controls and scrollbars for a light page that does not exist.
export const viewport = {
  colorScheme: "light",
  // The one literal hex in the app, and unavoidable: browser chrome is painted
  // before any stylesheet, so this cannot read `var(--bg)`. It must be kept
  // equal to --bg in globals.css by hand.
  themeColor: "#FFFFFF",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${serif.variable} ${inter.variable} ${jetbrains.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-bg text-ink-invert">
        {children}
      </body>
    </html>
  );
}
