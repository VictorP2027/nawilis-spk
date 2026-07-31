import { randomBytes, createCipheriv } from 'node:crypto';
import { connect, close, collections } from '../mongo.js';

/**
 * Store an encrypted per-branch Turboly service-account credential.
 * AES-256-GCM; the ciphertext layout (iv|tag|data) matches session.ts's decrypt.
 *
 * Usage:
 *   CREDENTIAL_ENC_KEY=<base64-32-bytes> \
 *   npm run -w @spk/core exec tsx src/seed/set-credential.ts -- NWL-BKS user@nawilis.com 'password'
 *
 * Generate a key once:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
function encrypt(plain: string, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('CREDENTIAL_ENC_KEY must be 32 bytes (base64)');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]).toString('base64');
}

async function main(): Promise<void> {
  const [branchCode, username, password] = process.argv.slice(2);
  const keyB64 = process.env.CREDENTIAL_ENC_KEY;
  if (!branchCode || !username || !password || !keyB64) {
    console.error('usage: CREDENTIAL_ENC_KEY=… tsx src/seed/set-credential.ts -- <branchCode> <username> <password>');
    process.exit(1);
  }
  await connect();
  await collections.tbCredentials().updateOne(
    { _id: branchCode },
    { $set: { _id: branchCode, branchCode, username, passwordEnc: encrypt(password, keyB64), updatedAt: new Date().toISOString() } },
    { upsert: true },
  );
  console.log(`✓ credential stored for ${branchCode} (${username})`);
  await close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
