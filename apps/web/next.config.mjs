import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the monorepo-root .env so MONGODB_URI (local or Atlas) reaches the
// Next server runtime. Next only auto-loads env from its own app dir otherwise.
try {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
  process.loadEnvFile(root);
} catch {
  /* no .env yet — falls back to localhost defaults */
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @spk/core is a workspace package with server-only bits (mongodb); keep it
  // external to the client bundle. Only the API routes / server components use it.
  serverExternalPackages: ['mongodb', '@spk/core'],
  transpilePackages: [],
};
export default nextConfig;
