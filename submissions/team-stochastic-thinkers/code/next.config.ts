import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Node-only drivers stay out of the bundle.
  serverExternalPackages: ["mongodb", "twilio"],
  // Dev-only (docs/CONTRACTS.md §8): hostnames allowed to load /_next/* from `next dev` — the cloudflared tunnel plus
  // any extra hosts in RESQ_DEV_ORIGINS (e.g. the LAN-IP fallback). Hostnames only, no scheme/port; `*` = one DNS label.
  allowedDevOrigins: ["*.trycloudflare.com", ...(process.env.RESQ_DEV_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean)],
};

export default nextConfig;
