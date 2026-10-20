/**
 * Next.js config — NEXUS consumer app (D1: Next 15 App Router, port 3000).
 *
 * `@nexus/ui` is consumed as TypeScript source from the workspace (no build step),
 * which is what `transpilePackages` is for.
 *
 * Every outbound base URL is an env var with a documented default; see .env.example.
 * Nothing here talks to Postgres ([`API_CONTRACT.md`](../../docs/API_CONTRACT.md) §0: web only calls
 * platform + AI, always through the BFF).
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@nexus/ui'],

  experimental: {
    // Optimistically pre-warm the proxy route so first search is not cold.
    optimizePackageImports: ['framer-motion'],
  },

  images: {
    // Demo imagery is generated locally under /media as SVG (next/image cannot optimize
    // or proxy it), so the optimizer is off and no remote loader is configured — which
    // also makes hotlinking "real" stock photos impossible (§155).
    unoptimized: true,
  },

  eslint: {
    // Lint runs as its own CI step (`npm run lint`); a build must not silently skip it.
    ignoreDuringBuilds: false,
  },

  typescript: {
    ignoreBuildErrors: false,
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
      {
        // BFF + AI responses are never cacheable at the edge (§103: price/availability no-store).
        source: '/api/nexus/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
          { key: 'X-Accel-Buffering', value: 'no' },
        ],
      },
    ];
  },
};

export default nextConfig;

