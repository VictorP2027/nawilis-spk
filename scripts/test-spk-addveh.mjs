// Queued SPK for an EXISTING customer (ADITYA) but a NEW vehicle → exercises the
// add-vehicle-to-existing-customer path. Usage: node --env-file=.env scripts/test-spk-addveh.mjs 7788
import { connect, close, collections, buildSpkDoc, loadMirror, resolveSkus, assignMechanic } from '/Users/victorphisitkul/Desktop/untitled folder 2/packages/core/dist/index.js';
const s = process.argv[2] || '7788';
await connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'spk');
const input = {
  uploadId: 'addveh-' + s + '-' + Date.now(),
  docType: 'SPK_NAWILIS', branchCode: 'NWL-BKS', captureMode: 'typed',
  operatorUserId: 'test', operatorPinVerified: true, deviceBindingVerified: true,
  spkNumber: null, qrPayload: null, capturedAt: new Date().toISOString(),
  customer: { nama: 'ADITYA', wa: null, alamat: null, kontakLain: null, turbolyCustomerId: null },
  vehicle: { noPolisi: `B${s}NW`, merk: 'Toyota', tipe: 'Avanza', tahun: 2017, warna: 'Grey', km: '15000' },
  complaint: 'existing customer new car test', jobLines: [{ serviceCode: 'SPOORING', ordered: true, qty: 1, keterangan: 'Spooring', quotedPrice: null }],
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
await assignMechanic(doc._id, { mechanicCode: 'DEMO-ADV', by: 'test', via: 'console' });
console.log('queued ADITYA+new-vehicle SPK:', doc._id, '| plate:', doc.vehicle.noPolisi.display);
await close();
