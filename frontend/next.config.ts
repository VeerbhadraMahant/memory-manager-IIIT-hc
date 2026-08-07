import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The circular badge pinned to the bottom-left corner is Next's own dev
  // indicator (a <nextjs-portal>, not our markup), so it never ships in a
  // production build — but the demo runs on `next dev`, where it sits on top of
  // the conversation column. Off, so it cannot appear on stage. Compile and
  // runtime errors are still surfaced.
  devIndicators: false,
};

export default nextConfig;
