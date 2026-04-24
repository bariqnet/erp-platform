/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Standalone output bundles a minimal Node server with only the deps
  // the app uses (CLAUDE.md §2 — ECS Fargate). infra/docker/
  // Dockerfile.console copies the `.next/standalone/` + `.next/static/`
  // output into a lean runtime image.
  output: "standalone",
  // The monorepo lives several levels above apps/console. Tell Next.js
  // where the repo root is so `output: standalone` traces the right
  // node_modules tree.
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
