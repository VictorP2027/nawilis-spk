import { connect, close, collections, buildSpkDoc, loadMirror, resolveSkus, assignMechanic } from '/Users/victorphisitkul/Desktop/untitled folder 2/packages/core/dist/index.js';

const uri = process.env.MONGODB_URI, dbn = process.env.MONGODB_DB || 'spk';
await connect(uri, dbn);

const input = {
  uploadId: 'atlas-aditya-' + Date.now(),
  docType: 'SPK_NAWILIS', branchCode: 'NWL-BKS', captureMode: 'typed',
  operatorUserId: 'test', operatorPinVerified: true, deviceBindingVerified: true,
  spkNumber: null, qrPayload: null, capturedAt: new Date().toISOString(),
  customer: { nama: 'ADITYA', wa: null, alamat: null, kontakLain: null, turbolyCustomerId: null },
  vehicle: { noPolisi: 'B1743RKA', merk: 'Toyota', tipe: 'Avanza', tahun: 2021, warna: 'Silver', km: '12500' },
  complaint: 'auto test', jobLines: [{ serviceCode: 'SPOORING', ordered: true, qty: 1, keterangan: 'Spooring', quotedPrice: null }],
  conditionChecks: [], rekomendasiService: null, estimasiMinutes: null,
  serviceAdvisorName: process.argv[2] || 'DEVI FITRIANI', salespersonName: process.argv[2] || 'DEVI FITRIANI',
  signatures: { menyerahkanPresent: true, menyerahkanInkDensity: null, menerimaPresent: true, menerimaNamaJelas: process.argv[2] || 'DEVI FITRIANI' },
  attachments: [],
};

let doc = buildSpkDoc(input);
doc.uploadId = input.uploadId;
doc.signatures.menerima.namaJelas = process.argv[2] || 'DEVI FITRIANI';
const mirror = await loadMirror('NWL-BKS');
doc = resolveSkus(doc, mirror.skuFor);
doc.state = 'awaiting_assignment';
await collections.spk().insertOne(doc);
const q = await assignMechanic(doc._id, { mechanicCode: 'DEMO-ADV', by: 'test', via: 'console' });
console.log('created + assigned:', doc._id, '| state:', q?.state, '| sku:', doc.jobLines[0].turbolySku, '| storeId:', mirror.store?.turbolyStoreId);
await close();
