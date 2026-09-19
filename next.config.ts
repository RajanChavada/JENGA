import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse (progress-report text extraction, app/api/reports/route.ts) and its
  // canvas dependency need to run as real Node modules, not be bundled — required
  // for serverless deploys (Vercel etc.), per pdf-parse's troubleshooting docs.
  serverExternalPackages: ["pdf-parse", "@napi-rs/canvas"],
};

export default nextConfig;
