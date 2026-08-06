# Menyiapkan gateway WhatsApp (WAHA) di komputer lain

Gateway ini yang MENGIRIM hasil Check & Go ke customer. Ia harus berjalan di
satu komputer yang selalu menyala, berdampingan dengan "watcher"-nya. Tombol
**Kirim Hasil via WA** di papan alur hanya MENANDAI dokumen; pengirimannya
terjadi di sini, maksimal ~30 detik kemudian.

## Yang dibutuhkan

- Komputer yang selalu menyala (Mac / Windows / Linux) dengan internet
- **Docker Desktop** dan **Node.js ≥ 20** ter-install, plus **git**
- Akses ke repo GitHub `VictorP2027/nawilis-spk` (minta di-invite dulu)
- **HP pengirim** — nomor WhatsApp yang akan menjadi PENGIRIM pesan
  (di-pair sekali lewat QR, seperti WhatsApp Web)
- Isi `.env`: minta `MONGODB_URI` dari admin

> ⚠ **Satu nomor pengirim = satu gateway.** Kalau gateway pindah komputer,
> matikan yang lama (`docker compose down`) sebelum pairing di yang baru.

## Langkah

```bash
# 1. Ambil kode dan siapkan
git clone https://github.com/VictorP2027/nawilis-spk.git
cd nawilis-spk
npm install
npm run build -w @spk/core

# 2. Buat file .env di root repo (JANGAN di-commit) berisi:
#    MONGODB_URI=<dari admin>
#    MONGODB_DB=spk
#    WHATSAPP_PROVIDER=waha
#    WAHA_BASE_URL=http://127.0.0.1:3000
#    WAHA_API_KEY=nawilis-local-gateway
#    WAHA_SESSION=default

# 3. Nyalakan container WAHA
#    ⚠ compose.yaml memakai image ARM (Mac Apple Silicon).
#    Di Windows/Linux/Intel: edit compose.yaml,
#    ganti `devlikeapro/waha:noweb-arm` → `devlikeapro/waha:noweb`
docker compose up -d waha
```

**4. Pairing HP pengirim** — buka `http://127.0.0.1:3000/dashboard`
(login `nawilis` / `nawilis-local-only`), start session **default**, lalu di HP
pengirim: *WhatsApp → Perangkat tertaut → Tautkan perangkat* → scan QR.
Session tersimpan di volume Docker, jadi pairing cukup sekali dan tahan
restart. Kalau status session `FAILED`, tombol **Restart** biasanya cukup —
tidak perlu scan ulang.

```bash
# 5. Uji tanpa mengirim apa pun (dry run — hanya menampilkan antrean)
node --env-file=.env scripts/alerts-drain.mjs

# 6. Jalankan watcher-nya (ini yang benar-benar mengirim)
node --env-file=.env scripts/alerts-drain.mjs --send --watch=30
```

## Supaya jalan terus (auto-start)

- **macOS**: pakai `ops/launchd/com.nawilis.alerts-watch.plist` — edit
  `WorkingDirectory` ke lokasi clone dan path `node` (`which node`), lalu:
  `cp` ke `~/Library/LaunchAgents/` dan `launchctl load` file itu.
  Log di `/tmp/nawilis-alerts-watch.log`.
- **Windows**: Task Scheduler → task "At startup" menjalankan perintah
  langkah 6 (program `node`, arguments & start-in diarahkan ke repo).
- **Linux**: unit systemd `Restart=always` menjalankan perintah langkah 6.

## Cara kerja & batas amannya

- Watcher HANYA mengirim dokumen yang sudah di-klik **Kirim** oleh staf di
  papan alur (stempel `requested`) — intake baru saja tidak memicu pesan.
- Dokumen yang sudah terkirim tidak pernah dikirim dua kali (stempel `live`).
- Maks 25 kiriman per putaran, jeda 3 detik antar pesan, hanya dokumen ≤ 7
  hari — nomor pengirim tidak boleh terlihat seperti spam-cannon.
- Gateway mati / internet putus: watcher menunggu dan mencoba lagi sendiri;
  antrean tidak hilang.
- WAHA memakai protokol WhatsApp Web tidak resmi. Untuk volume uji coba aman;
  untuk 23 cabang produksi, pertimbangkan nomor khusus atau Meta/Twilio resmi.
