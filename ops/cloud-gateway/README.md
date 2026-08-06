# Gateway WhatsApp di cloud — tanpa komputer lokal

Dengan bundle ini, TIDAK ADA komputer kantor/laptop yang harus menyala.
Gateway (WAHA) + watcher berjalan di satu server cloud kecil (~US$5/bulan:
Hetzner CX22, DigitalOcean Basic, Vultr, dsb — apa pun yang punya Docker).

Setelah hari pertama, server ini tidak pernah disentuh lagi: status dan QR
pairing muncul di **/admin** aplikasi web (lewat Mongo), pengiriman dipicu
dari papan alur, dan sesi FAILED me-restart dirinya sendiri.

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
