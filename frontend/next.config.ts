import path from 'path';
import type { NextConfig } from 'next';

// ponytail: fixtures are imported straight from ../data/*.json so they never drift
// from the data agent's copy. Tracing root must be the repo root for that to build.
const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, '..'),
};

export default nextConfig;
