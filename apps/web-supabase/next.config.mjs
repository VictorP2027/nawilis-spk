import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the monorepo-root .env so SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY reach
// the Next server runtime. Next only auto-loads env from its own app dir otherwise.
try {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
  process.loadEnvFile(root);
} catch {
  /* no .env yet — falls back to localhost defaults */
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Keep server-only workspace packages out of the client bundle.
  serverExternalPackages: ['mongodb', '@spk/core', '@spk/core-supabase', '@supabase/supabase-js'],
  transpilePackages: [],
};
export default nextConfig;
