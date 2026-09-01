import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  // Pin the output-tracing root to THIS repo. Without it, Next infers a
  // "workspace root" from lockfiles in parent directories (e.g. a
  // sandbox/workspace bun.lock above the checkout) and emits the
  // standalone server at .next/standalone/<inferred-root>/<repo>/server.js
  // — which silently breaks `next start`/`bun run start` and any
  // preview/deployment that expects .next/standalone/server.js.
  outputFileTracingRoot: path.resolve(__dirname),
  // Per POSTYAR spec §104: NEVER ignoreBuildErrors. Surface real type
  // errors instead of suppressing them.
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
};

export default nextConfig;
