# Alternatif tanpa WAHA: WhatsApp Cloud API resmi (Meta)

Jalur ini menghapus SEMUA infrastruktur sendiri: tidak ada WAHA, tidak ada
Docker, tidak ada komputer/server yang menyala. Mengirim = panggilan HTTPS
resmi ke Meta, dijalankan oleh cron GitHub Actions
(`.github/workflows/alerts.yml`) setiap 5 menit — sama seperti worker Turboly.
Papan alur tidak berubah sedikit pun: Kirim WA tetap menandai dokumen; hanya
PENGIRIMNYA yang berbeda.

## Jujur soal biayanya

- **Bukan "scan QR selesai".** Perlu akun Meta Business + app WhatsApp di
  developers.facebook.com, dan nomor pengirim TIDAK BOLEH sedang dipakai
  WhatsApp biasa (harus nomor khusus, atau di-migrasi).
- **Pesan yang memulai percakapan (hasil Check & Go) wajib pakai TEMPLATE
  yang di-approve Meta** — free-text hanya boleh membalas customer dalam
  jendela 24 jam. Template perlu ditinjau Meta (biasanya < 1 hari).
- **Ada tarif per percakapan** untuk pesan yang diinisiasi bisnis (kategori
  utility, kecil per pesan, perlu metode pembayaran di Meta). Nomor yang
  belum diverifikasi bisnis dibatasi ±250 percakapan/hari — cukup untuk uji
  coba, perlu verifikasi untuk 23 cabang.
- Imbalannya: resmi (tidak ada risiko banned seperti protokol tidak resmi),
  tanpa server, tanpa sesi yang bisa FAILED.

## Langkah

1. **Meta app** — developers.facebook.com → Create App → tambahkan produk
   *WhatsApp*. Catat **Phone number ID** dan buat **permanent access token**
   (System User di Business Settings → token dengan permission
   `whatsapp_business_messaging`).
2. **Template** — di WhatsApp Manager, buat template kategori *Utility*
   (mis. `checkgo_report`, bahasa `id`) dengan LIMA parameter posisi persis
   seperti kontrak di `.env.example`:
   `{{1}} nama · {{2}} nomor polisi · {{3}} rekomendasi · {{4}} tanggal · {{5}} cabang`.
   Tunggu approved.
3. **Secrets repo** — GitHub → Settings → Secrets → Actions:
   `WHATSAPP_PROVIDER=meta`, `WHATSAPP_ACCESS_TOKEN`,
   `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_REPORT_TEMPLATE=checkgo_report`.
   (`MONGODB_URI` sudah ada.)
4. Selesai. Workflow `send-whatsapp-alerts` berhenti melewati dirinya dan
   mulai mengirim setiap 5 menit. Sebelum secrets diisi, workflow inert —
   aman dibiarkan.

## Pindah jalur / rollback

Kedua jalur membaca antrean yang sama (stempel `requested` di Mongo), jadi
berpindah WAHA ↔ Meta hanya soal jalur mana yang aktif:
- **Ke Meta**: isi secrets di atas, matikan watcher WAHA.
- **Kembali ke WAHA**: kosongkan `WHATSAPP_PROVIDER` di secrets (workflow
  kembali inert), nyalakan watcher WAHA.
Jangan jalankan keduanya bersamaan — dua pengirim akan berlomba mengambil
antrean yang sama.
