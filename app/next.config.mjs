/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `ws` and `pg` are server-only; keep them out of the client bundle.
  experimental: {
    serverComponentsExternalPackages: ['ws', 'pg'],
  },
};

export default nextConfig;
