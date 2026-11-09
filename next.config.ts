import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // On Vercel the app builds with native `next build`. Type-check only the web
  // app there: db/ and worker/ are Cloudflare-only scaffolding for the
  // ChatGPT Sites build and import `cloudflare:workers`.
  ...(process.env.VERCEL ? { typescript: { tsconfigPath: "tsconfig.vercel.json" } } : {}),
};

export default nextConfig;
