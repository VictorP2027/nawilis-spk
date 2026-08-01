// Creates an ADITYA / Demo-Advisor SPK and leaves it in `awaiting_assignment`
// (does NOT auto-assign) so you can click "Tugaskan →" in /admin to test the
// instant GitHub trigger. Run: node --env-file=.env scripts/test-spk-await.mjs
import { connect, close, collections, buildSpkDoc, loadMirror, resolveSkus } from '/Users/victorphisitkul/Desktop/untitled folder 2/packages/core/dist/index.js';

await connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'spk');

const input = {
  uploadId: 'await-aditya-' + Date.now(),
  docType: 'SPK_NAWILIS', branchCode: 'NWL-BKS', captureMode: 'typed',
  operatorUserId: 'test', operatorPinVerified: true, deviceBindingVerified: true,
  spkNumber: null, qrPayload: null, capturedAt: new Date().toISOString(),
  customer: { nama: 'ADITYA', wa: null, alamat: null, kontakLain: null, turbolyCustomerId: null },
  vehicle: { noPolisi: 'B1743RKA', merk: 'Toyota', tipe: 'Avanza', tahun: 2021, warna: 'Silver', km: '12500' },
  complaint: 'instant-trigger test', jobLines: [{ serviceCode: 'SPOORING', ordered: true, qty: 1, keterangan: 'Spooring', quotedPrice: null }],
  conditionChecks: [], rekomendasiService: null, estimasiMinutes: null,
  serviceAdvisorName: 'Demo Advisor', salespersonName: 'Demo Advisor',
  signatures: { menyerahkanPresent: true, menyerahkanInkDensity: null, menerimaPresent: true, menerimaNamaJelas: 'Demo Advisor' },
  attachments: [],
};

let doc = buildSpkDoc(input);
doc.uploadId = input.uploadId;
doc.signatures.menerima.namaJelas = 'Demo Advisor';
const mirror = await loadMirror('NWL-BKS');
doc = resolveSkus(doc, mirror.skuFor);
doc.state = 'awaiting_assignment';
await collections.spk().insertOne(doc);
console.log('awaiting_assignment SPK ready:', doc._id, '| ADITYA / B1743RKA / Demo Advisor');
console.log('→ Go to /admin, type any code, click "Tugaskan →" on this one, then watch the Actions tab.');
await close();
