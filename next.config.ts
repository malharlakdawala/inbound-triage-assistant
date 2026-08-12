import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Fail the build on type errors rather than shipping them.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
