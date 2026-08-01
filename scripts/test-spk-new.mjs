// Creates a QUEUED SPK for a brand-NEW customer (not in Turboly) so the worker
// exercises the Add-New-Customer creation path. Usage:
//   node --env-file=.env scripts/test-spk-new.mjs 9012
import { connect, close, collections, buildSpkDoc, loadMirror, resolveSkus, assignMechanic } from '/Users/victorphisitkul/Desktop/untitled folder 2/packages/core/dist/index.js';

const s = process.argv[2] || '9012';
await connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'spk');

const input = {
  uploadId: 'newcust-' + s + '-' + Date.now(),
  docType: 'SPK_NAWILIS', branchCode: 'NWL-BKS', captureMode: 'typed',
  operatorUserId: 'test', operatorPinVerified: true, deviceBindingVerified: true,
  spkNumber: null, qrPayload: null, capturedAt: new Date().toISOString(),
  customer: { nama: `NEWCUST ${s}`, wa: null, alamat: `JL BARU NO ${s}`, kontakLain: null, turbolyCustomerId: null },
  vehicle: { noPolisi: `B${s}TST`, merk: 'Toyota', tipe: 'Avanza', tahun: 2019, warna: 'Black', km: '8000' },
  complaint: 'new customer test', jobLines: [{ serviceCode: 'SPOORING', ordered: true, qty: 1, keterangan: 'Spooring', quotedPrice: null }],
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
console.log('queued NEW-customer SPK:', doc._id);
console.log('  customer:', doc.customer.nama, '| plate:', doc.vehicle.noPolisi.display, '| make:', doc.vehicle.merkNormalized, '| model:', doc.vehicle.tipeNormalized, '| year:', doc.vehicle.tahun);
await close();
