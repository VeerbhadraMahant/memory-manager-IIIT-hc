import type { Metadata } from "next";
import { JetBrains_Mono, Poppins } from "next/font/google";
import "./globals.css";

// §1 type. Poppins carries all UI and display copy (weight 300 is the headline voice);
// JetBrains Mono means "the machine generated this" and never carries conversational
// content.
const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["300", "400", "500", "700"],
  // §3 font-loading: swap rather than block, so no invisible-text flash.
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

// The app is dark everywhere (Tableland); there is no light theme to switch to, so the
// colour-scheme is declared rather than inherited — otherwise the browser paints
// form controls and scrollbars for a light page that does not exist.
export const viewport = {
  colorScheme: "dark",
  // The one literal hex in the app, and unavoidable: browser chrome is painted
  // before any stylesheet, so this cannot read `var(--bg)`. It must be kept
  // equal to --bg in globals.css by hand.
  themeColor: "#101E1E",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${poppins.variable} ${jetbrains.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-bg text-ink-invert">
        {children}
      </body>
    </html>
  );
}
