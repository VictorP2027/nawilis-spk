// Sample Check & Go records for testing the /alerts WhatsApp ledger.
//
//   node --env-file=.env scripts/seed-wa-samples.mjs            # create
//   node --env-file=.env scripts/seed-wa-samples.mjs --purge    # remove them
//
// Every sample carries the SAME WhatsApp number (the test handset), so anything
// sent from /alerts lands on one phone instead of a real customer's. They are
// created with directPush:false — they park in awaiting_assignment and never
// reach Turboly, because the point is exercising the sender, not the ERP.
// Findings differ per record so the five messages do not read identically:
// a clean car, worn brakes, bad tyres, a failing battery, dirty oil.
const WA = process.env.WA_TEST ?? '+14047034284';
const BASE = process.env.BASE ?? 'http://localhost:3000';
const COOKIE = `spk_auth=${process.env.SPK_SESSION_SECRET}`;
const TAG = 'WA-SAMPLE';

if (process.argv.includes('--purge')) {
  const { connect, close, collections } = await import('../packages/core/dist/index.js');
  await connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'spk');
  const r = await collections.spk().deleteMany({ 'customer.waE164': WA, uploadId: new RegExp(`^${TAG}`) });
  console.log(`purged ${r.deletedCount} sample(s)`);
  await close();
  process.exit(0);
}

const sec = (code, verdict, items = [], rekomendasi = []) => ({ code, verdict, items, rekomendasi, rekomendasiLain: null, extraParts: [] });
const SAMPLES = [
  { nama: 'BUDI SANTOSO', plate: 'B1101WAS', merk: 'Toyota', tipe: 'Avanza', tahun: 2019, warna: 'Hitam', km: '48200',
    note: 'semua sehat',
    sections: [sec('OLI_MESIN','BAGUS'), sec('PENDINGIN',null,[{code:'PD_COOLANT',verdict:'OK',readings:[{code:'TEMP',value:'-25'}]},{code:'PD_TUTUP',verdict:'OK',readings:[]}])],
    tires: [{position:'DEPAN_KIRI',merkUkuran:'Bridgestone 185/65',tekanan:'CUKUP',flags:[]}], picks: [] },
  { nama: 'SITI RAHAYU', plate: 'B1202WAS', merk: 'Honda', tipe: 'Brio', tahun: 2021, warna: 'Merah', km: '31500',
    note: 'kanvas rem tipis',
    sections: [sec('OLI_MESIN','BAGUS'), sec('REM',null,[{code:'REM_KANVAS_DPN',verdict:'TIPIS',readings:[]},{code:'REM_JERNIH',verdict:'KERUH',readings:[]}],['GANTI_KANVAS_DPN','KMR'])],
    tires: [{position:'DEPAN_KANAN',merkUkuran:'Dunlop 175/65',tekanan:'CUKUP',flags:[]}], picks: [] },
  { nama: 'AGUS PRATAMA', plate: 'B1303WAS', merk: 'Mitsubishi', tipe: 'Xpander', tahun: 2020, warna: 'Silver', km: '76400',
    note: 'ban retak + spooring',
    sections: [sec('OLI_MESIN','BAGUS')],
    tires: [
      {position:'DEPAN_KIRI',merkUkuran:'GT Radial 205/55',tekanan:'KURANG',psi:'24',flags:['RETAK','AUS_TIDAK_RATA']},
      {position:'DEPAN_KANAN',merkUkuran:'GT Radial 205/55',tekanan:'KURANG',psi:'25',flags:['RETAK']},
      {position:'BELAKANG_KIRI',merkUkuran:'GT Radial 205/55',tekanan:'CUKUP',flags:[]},
      {position:'BELAKANG_KANAN',merkUkuran:'GT Radial 205/55',tekanan:'CUKUP',flags:['AUS_TIDAK_RATA']}],
    std: '33', picks: ['SPOORING','BALANCING','GANTI_BAN'] },
  { nama: 'DEWI LESTARI', plate: 'B1404WAS', merk: 'Suzuki', tipe: 'Ertiga', tahun: 2018, warna: 'Putih', km: '92300',
    note: 'aki + filter',
    sections: [sec('KELISTRIKAN',null,[{code:'KL_AIR_AKI',verdict:'KURANG',readings:[]},{code:'KL_AKI',verdict:'TIDAK',readings:[]}],['GANTI_AKI','TAMBAH_AIR_AKI']),
               // Chynthia's review case: coolant outside the printed range,
               // WITH the measured value the message must now show.
               sec('PENDINGIN',null,[{code:'PD_COOLANT',verdict:'TIDAK',readings:[{code:'TEMP',value:'-10'}]}],['GANTI_COOLANT']),
               sec('LAIN',null,[{code:'LL_FILTER_UDARA',verdict:'KOTOR',readings:[]}],['FILTER_UDARA_GANTI'])],
    tires: [{position:'BELAKANG_KIRI',merkUkuran:'Achilles 185/65',tekanan:'CUKUP',flags:[]}], picks: [] },
  { nama: 'RUDI HARTONO', plate: 'B1505WAS', merk: 'Daihatsu', tipe: 'Xenia', tahun: 2017, warna: 'Abu-abu', km: '134800',
    note: 'oli kotor + ATF',
    sections: [sec('OLI_MESIN','KOTOR',[{code:'OM_OLI',verdict:null,readings:[{code:'MERK_SAE',value:'Castrol 10W-40'}]}],['GANTI_OLI','ENGINE_FLUSH']),
               sec('ATF','KOTOR',[],['KURAS_ATF'])],
    tires: [{position:'DEPAN_KIRI',merkUkuran:'Accelera 185/70',tekanan:'LEBIH',psi:'41',flags:[]}], std: '33/36', picks: [] },
];

let ok = 0;
for (const [i, s] of SAMPLES.entries()) {
  const body = {
    uploadId: `${TAG}-${String(i + 1).padStart(2, '0')}-${Date.now()}`,
    branchCode: 'NWL-BKS', captureMode: 'typed',
    operatorUserId: 'wa-sample', operatorPinVerified: true, deviceBindingVerified: true,
    directPush: false,
    customer: { nama: s.nama, wa: WA, alamat: 'Jl. Contoh No. 1, Bekasi' },
    vehicle: { noPolisi: s.plate, merk: s.merk, tipe: s.tipe, tahun: s.tahun, warna: s.warna, km: s.km },
    complaint: null, estimasiMinutes: 30,
    serviceAdvisorName: 'DEVI FITRIANI', salespersonName: 'DEVI FITRIANI',
    mechanicName: 'AHMAD JAYNUDIN',
    checkReport: { sections: s.sections, tires: s.tires, tireRekomendasi: { picks: s.picks, lain: [] }, tekananStandar: s.std ?? null },
    signatures: { menyerahkanPresent: true, menyerahkanNamaJelas: s.nama, menerimaPresent: true, menerimaNamaJelas: 'DEVI FITRIANI' },
  };
  const r = await fetch(`${BASE}/api/checkgo`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: COOKIE }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { ok++; console.log(`  ✓ ${s.plate.padEnd(9)} ${s.nama.padEnd(16)} ${String(s.note).padEnd(22)} ${j.spkId}`); }
  else console.log(`  ✗ ${s.plate}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 160)}`);
}
console.log(`\n${ok}/${SAMPLES.length} samples created — all messaging ${WA}`);
