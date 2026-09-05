/**
 * THE BOARD MUST OFFER EVERY STEP IT ASKS FOR — EXCEPT WHERE WE SAY OTHERWISE.
 *
 * /api/flow/state sends the card a `nextAction` computed by nextFlowAction().
 * The board renders a button by looking that name up in the ACTIONS map in
 * apps/web/app/flow/page.tsx — a plain `ACTIONS[name] ?? null`. So a name the
 * server can emit but the map does not carry renders NO button, and because
 * the flow is a chain (canRunFlowAction gates create_wo on so === 'approved',
 * start_wo on wo === 'created', and so on) that card is stranded: every later
 * step stays unreachable forever.
 *
 * That is not hypothetical: dropping approve_so makes Work Order, QC and
 * Invoice unreachable for every new document, because
 * flowPatchAfter('approve_so') is the ONLY writer of so === 'approved' in the
 * repo and nothing reads Turboly's status back.
 *
 * approve_so is nevertheless absent ON PURPOSE — the whole lifecycle is driven
 * in Turboly and the board is a view to read and print from. OMITTED below
 * records that decision, so the consequence stays written down and the
 * remaining steps are still protected from an accidental removal.
 *
 *   npx tsx tests/flow-actions.mts
 */
import { readFile } from 'node:fs/promises';

let passed = 0;
let failed = 0;
const ok = (cond: boolean, label: string): void => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ FAIL: ${label}`); }
};

const coreSrc = await readFile(new URL('../packages/core/src/flow.ts', import.meta.url), 'utf8');
const pageSrc = await readFile(new URL('../apps/web/app/flow/page.tsx', import.meta.url), 'utf8');

// Every literal nextFlowAction() can hand back.
const fn = coreSrc.slice(coreSrc.indexOf('export function nextFlowAction'));
const body = fn.slice(0, fn.indexOf('\n}'));
const emitted = [...new Set([...body.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]!))];

/** Deliberately not offered by the board. Adding to this list is a decision. */
const OMITTED = new Set(['approve_so']);
ok(emitted.length >= 6, `nextFlowAction bisa mengembalikan ${emitted.length} aksi: ${emitted.join(', ')}`);
ok(emitted.includes('approve_so'), 'termasuk approve_so — server masih meminta langkah ini');
ok(OMITTED.has('approve_so'), 'dan approve_so memang sengaja tidak ditawarkan papan (kerja dilakukan di Turboly)');

// Every key the board's ACTIONS map carries.
const map = pageSrc.slice(pageSrc.indexOf('const ACTIONS: Record<string, ActionDef> = {'));
const mapBody = map.slice(0, map.indexOf('\n};'));
const offered = [...new Set([...mapBody.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]!))];
ok(offered.length >= 6, `papan menawarkan ${offered.length} aksi`);

for (const a of emitted) {
  if (OMITTED.has(a)) {
    ok(!offered.includes(a), `"${a}" sengaja tidak ada tombolnya — sesuai keputusan`);
    continue;
  }
  ok(offered.includes(a), `papan punya tombol untuk "${a}" — kartu tidak tersangkut`);
}

// The chain itself: each gate's precondition is a state only the previous
// action writes, so a missing button anywhere breaks everything after it.
ok(/case 'create_wo': return f\.so === 'approved'/.test(coreSrc), 'create_wo memang menunggu so === approved');
ok(coreSrc.match(/return \{ so: 'approved' \}/g)?.length === 1, 'dan hanya SATU tempat yang menulis so === approved');

// The consequence of OMITTED, stated so nobody rediscovers it by surprise: with
// approve_so absent and no Turboly read-back, a new card stops at Service Order.
const pageHasNote = /Diproses di Turboly/.test(pageSrc);
ok(pageHasNote, 'kartu yang berhenti di Service Order menjelaskan bahwa urusannya di Turboly');
ok(!/routeReadsBackTurbolyStatus/.test(coreSrc), 'belum ada pembacaan status Turboly — kalau nanti ada, OMITTED bisa dikosongkan');

console.log(`\n${passed} lulus, ${failed} gagal`);
process.exit(failed ? 1 : 0);
