// LOCAL RUNS ONLY. This network answers SRV but times out on TXT, and a
// mongodb+srv:// URI needs both, so the driver dies before connecting. Resolve
// the seedlist ourselves and hand the driver a plain mongodb:// URI.
// config.ts calls process.loadEnvFile() at import time, which would overwrite
// the rewrite — so patch that too. CI never loads this file.
import dns from 'node:dns';
import { readFileSync } from 'node:fs';

dns.setServers(['8.8.8.8', '1.1.1.1']);

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const srvUri = /^MONGODB_URI=(.+)$/m.exec(envText)?.[1]?.trim() ?? '';
let direct = '';
const m = /^mongodb\+srv:\/\/([^@]*)@([^/?]+)(.*)$/.exec(srvUri);
if (m) {
  const [, auth, host, rest] = m;
  const srv = await dns.promises.resolveSrv(`_mongodb._tcp.${host}`).catch(() => []);
  if (srv.length) {
    const hosts = srv.map((r) => `${r.name.replace(/\.$/, '')}:${r.port}`).join(',');
    const tail = rest.includes('?') ? `${rest}&` : `${rest || '/'}?`;
    direct = `mongodb://${auth}@${hosts}${tail}ssl=true&authSource=admin`;
    console.error(`[dns-public] seedlist: ${srv.length} host(s)`);
  }
}

if (direct) {
  process.env.MONGODB_URI = direct;
  const orig = process.loadEnvFile?.bind(process);
  if (orig) {
    process.loadEnvFile = (...args) => {
      const r = orig(...args);
      process.env.MONGODB_URI = direct;
      return r;
    };
  }
}
