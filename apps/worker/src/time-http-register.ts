import { connect, close } from '@spk/core';
import { registerWholesaleHttp, registerRetailHttp } from '@spk/core/turboly';

/** Time a real corporate registration over the HTTP fast path. No browser. */
const TAG = process.argv[2] ?? 'H1';
const cfg = {
  baseUrl: process.env.TURBOLY_BASE_URL ?? 'https://live.turboly.com',
  username: process.env.TURBOLY_USERNAME ?? '',
  password: process.env.TURBOLY_PASSWORD ?? '',
};

const ms = (t: number) => `${((Date.now() - t) / 1000).toFixed(2)}s`;

async function main(): Promise<void> {
  const t0 = Date.now();
  await connect(process.env.MONGODB_URI!, process.env.MONGODB_DB ?? 'spk');
  console.log(`mongo connect        ${ms(t0)}`);

  const t1 = Date.now();
  const co = await registerWholesaleHttp(cfg, {
    companyName: `PT HTTP UJI ${TAG}`,
    picName: `PIC ${TAG}`,
    npwp: '01.234.567.8-901.000',
    alamat: `JL HTTP NO ${TAG}, JAKARTA`,
    advisorName: 'DEVI FITRIANI',
  });
  console.log(`company  ${co.customerId}  ${ms(t1)}  ${co.customerUrl}`);

  const t2 = Date.now();
  const retail = await registerRetailHttp(cfg, {
    nama: `DRIVER HTTP ${TAG}`,
    phone: `+628129${TAG.charCodeAt(1) % 10}${TAG.charCodeAt(0) % 10}77771`,
    alamat: `JL HTTP NO ${TAG}, JAKARTA`,
    storeTurbolyId: '8339',
    companyName: `PT HTTP UJI ${TAG}`,
    companyId: co.customerId,
  });
  console.log(`retail   ${retail.customerId}  ${ms(t2)}  ${retail.customerUrl}`);

  console.log(`\nTOTAL (perusahaan + customer): ${ms(t1)}   [termasuk login: ${ms(t0)}]`);
  await close();
  process.exit(0);
}
main().catch(async (e) => {
  console.error('GAGAL:', (e as Error).message ?? e);
  await close().catch(() => {});
  process.exit(1);
});
