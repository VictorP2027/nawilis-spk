# Gateway WhatsApp di cloud — tanpa komputer lokal

Dengan bundle ini, TIDAK ADA komputer kantor/laptop yang harus menyala.
Gateway (WAHA) + watcher berjalan di satu server cloud kecil (~US$5/bulan:
Hetzner CX22, DigitalOcean Basic, Vultr, dsb — apa pun yang punya Docker).

Setelah hari pertama, server ini tidak pernah disentuh lagi: status dan QR
pairing muncul di **/admin** aplikasi web (lewat Mongo), pengiriman dipicu
dari papan alur, dan sesi FAILED me-restart dirinya sendiri.

## Opsi GRATIS

> **Tanpa kartu kredit sama sekali?** Tidak ada cloud tepercaya yang gratis
> DAN bebas kartu untuk proses yang menyala terus. Pilihan bebas-kartu yang
> nyata adalah perangkat yang sudah dimiliki: PC kantor (di bawah), laptop
> bekas, atau Raspberry Pi di salah satu cabang (`noweb-arm`). Layanan gratis
> tanpa kartu (Replit/Glitch) tidur saat idle — sesi WhatsApp mati.

- **Oracle Cloud "Always Free"** — VPS gratis permanen (bukan trial), cukup
  untuk gateway ini berkali-kali lipat. Daftar butuh kartu kredit (verifikasi,
  bukan tagihan), kapasitas ARM gratis kadang harus dicoba beberapa kali, dan
  karena ARM: ganti image di docker-compose.yml → `devlikeapro/waha:noweb-arm`.
- **PC kantor yang sudah ada** — gratis karena sudah menyala saat jam kerja.
  Antrean "Kirim WA" menunggu di Mongo, jadi PC mati semalaman tidak
  menghilangkan apa pun: watcher mengejar begitu PC menyala. Untuk pesan yang
  memang dikirim di jam kerja, ini praktis setara 24/7. Setup: ops/WAHA-SETUP.md.
- Google Cloud `e2-micro` (always free, RAM 1 GB — pas-pasan) juga bisa;
  AWS free tier hanya 12 bulan, tier gratis Render/Railway tidur saat idle —
  jangan dipakai untuk sesi WhatsApp.

## Sekali saja, di server baru

```bash
# server Ubuntu/Debian dengan Docker ter-install
git clone https://github.com/VictorP2027/nawilis-spk.git
cd nawilis-spk

# .env di root repo:
#   MONGODB_URI=<Atlas, sama dengan produksi>
#   MONGODB_DB=spk
#   WAHA_API_KEY=<string acak panjang — BUKAN default>
cp /path/ke/.env .env

docker compose -f ops/cloud-gateway/docker-compose.yml --env-file .env up -d --build
```

Lalu buka **/admin** di aplikasi web → kartu "WhatsApp Gateway" menampilkan QR
→ scan dengan HP pengirim. Selesai.

## Catatan

- **Satu nomor pengirim = satu gateway.** Matikan gateway lama (laptop) dulu:
  `docker compose down` di mesin lama, sebelum pairing di server.
- WAHA tidak membuka port publik sama sekali — hanya watcher (jaringan
  internal Docker) yang bisa mengaksesnya. Jalur keluar-masuknya Mongo.
- Host ARM (Hetzner CAX / AWS Graviton): ganti image di docker-compose.yml
  menjadi `devlikeapro/waha:noweb-arm`.
- Update kode watcher: `git pull` lalu ulangi perintah `up -d --build`.
- Bundle ini sudah diuji utuh sebagai container terhadap gateway dan Atlas
  produksi sebelum di-commit.
