import { sb } from '../client.js';
import { REF_BRANCHES, REF_SERVICES } from '@spk/core';

/** Seed baseline state on Supabase (schema.sql must already be run). */
async function main(): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await sb().from('degradation_state').upsert({
    id: 'degradation',
    doc: { _id: 'degradation', rung: 0, since: now, reason: 'seed', lastCanaryHash: null, lastCanaryOkAt: null, updatedAt: now },
  });
  if (error) throw error;
  console.log(`✓ ${REF_BRANCHES.length} branches, ${REF_SERVICES.length} services (code refdata)`);
  console.log('✓ degradation singleton at rung 0 on Supabase');
}
main().catch((e) => { console.error(e); process.exit(1); });
