# Pelindungan data pribadi (UU No. 27 Tahun 2022)

Catatan internal GIBS. Pemberitahuan privasi untuk pengunjung ada di halaman
`#/privasi` (`PRIVACY` di `GIBS Site.dc.html`). Keduanya sebaiknya ditinjau konsultan
hukum sebelum situs dipakai publik.

## Catatan kegiatan pemrosesan

| | |
|---|---|
| Pengendali | PT Global Indo Buana Sentosa, Jl. Imam Bonjol No. 39, Cakranegara, Kota Mataram |
| Kegiatan | Permintaan penawaran (RFQ) dari website |
| Subjek data | Kontraktor, toko bangunan, perorangan |
| Data | Nama, nomor WhatsApp, jenis pemesan, nama proyek, kabupaten/kecamatan, tanggal kebutuhan, rencana bayar, produk + jumlah + catatan, waktu dan versi persetujuan. IP hanya sebagai hash di log. |
| Data spesifik (pasal 4 ayat 2) | Tidak ada |
| Tujuan | Menyusun penawaran, menghubungi pemesan, mengatur pengiriman |
| Dasar | Persetujuan eksplisit (checkbox, versi tersimpan) dan permintaan subjek sebelum kontrak |
| Penerima | Tim sales/admin GIBS; prosesor: Supabase atau Neon (hosting database) |
| Transfer ke luar negeri | Database di Singapura (ap-southeast-1). Pastikan perjanjian pemrosesan data (DPA) provider ditandatangani dan diarsipkan. |
| Retensi | 24 bulan, lalu dianonimkan otomatis (`RETENTION_MONTHS`) |
| Keamanan | Lihat SECURITY.md |

## Yang sudah diterapkan di sistem

- **Persetujuan**: formulir tidak bisa dikirim tanpa checkbox. Server menolak bila
  `consent_version` tidak sama dengan versi kebijakan yang berlaku, dan menyimpan
  `consent_version` + `consent_at` di setiap RFQ.
- **Minimisasi**: hanya kolom yang dibutuhkan; riwayat permintaan tidak lagi disimpan di
  browser (versi lama menyimpan nama/WA di localStorage, sekarang dihapus otomatis).
  Font dan skrip di-host sendiri sehingga IP pengunjung tidak dikirim ke Google Fonts/CDN.
- **Retensi**: `gibs.anonymize_expired` dijalankan server tiap 24 jam. Nama, WA, proyek,
  catatan dikosongkan; produk, jumlah, wilayah tetap untuk statistik.
- **Akuntabilitas**: setiap pembuatan, perubahan status, anonimisasi, dan akses DSR
  tercatat di `gibs.audit_log` (append-only, tanpa isi data pribadi).

## Prosedur permintaan subjek data (pasal 5–13)

Batas waktu: **3×24 jam** sejak permintaan diterima.

1. Terima permintaan lewat WhatsApp order atau langsung di toko. Verifikasi: pesan harus
   datang dari nomor WhatsApp yang sama dengan di RFQ (atau tunjukkan identitas di toko).
2. Jalankan dengan koneksi admin (`DATABASE_ADMIN_URL`):
   - **Akses / salinan**: `npm run dsr -- export 0812xxxxxxx --by "Nama Petugas" > salinan.json`
     lalu kirim isinya ke pemohon. Hapus file setelah terkirim.
   - **Hapus / tarik persetujuan**: `npm run dsr -- erase 0812xxxxxxx --by "Nama Petugas" --confirm`
   - **Perbaikan**: ubah kolom di Table Editor; perubahan tercatat otomatis di audit log.
3. Balas pemohon bahwa permintaan sudah diproses, beserta tanggalnya.

Percakapan WhatsApp di ponsel sales berada di luar sistem ini; hapus juga secara manual
bila pemohon meminta penghapusan.

## Bila kebijakan privasi berubah

Ubah teks `PRIVACY` di halaman, lalu naikkan `PRIVACY_VERSION` di halaman **dan** di
`lib/rfq.js` (format `YYYY-MM`). Formulir otomatis meminta persetujuan ulang.

## Belum tercakup kode (tindakan GIBS)

- Tunjuk pejabat/petugas pelindungan data dan cantumkan kontaknya di halaman privasi.
- Tandatangani DPA dengan Supabase/Neon.
- Pelatihan singkat staf sales: jangan meneruskan data pemesan ke pihak lain, jangan
  menyalin data ke spreadsheet pribadi.
