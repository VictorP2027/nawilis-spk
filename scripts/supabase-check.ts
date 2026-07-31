import { createClient } from '@supabase/supabase-js';

/** Connect to Supabase and report table row counts (the Postgres clone's db-check). */
async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  console.log('SUPABASE_URL :', url ?? '(unset)');
  if (!url || !key) {
    console.error('✗ Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.');
    process.exit(1);
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const tables = ['spk', 'spk_events', 'vehicles', 'tb_stores', 'tb_service_products', 'tb_mechanics', 'service_sku_map'];
  try {
    for (const t of tables) {
      const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true });
      if (error) throw new Error(`${t}: ${error.message}`);
      console.log(`  ${t.padEnd(20)} ${count ?? 0} rows`);
    }
    console.log('status      : ✓ connected');
  } catch (e) {
    console.error('status      : ✗ FAILED —', (e as Error).message);
    console.error('\nFix: run supabase/schema.sql in the Supabase SQL editor, and check the URL/service-role key.');
    process.exit(1);
  }
}
main();
