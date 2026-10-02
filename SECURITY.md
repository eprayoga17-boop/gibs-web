# Keamanan

Dokumen ini memetakan kontrol yang ada di kode ke **OWASP Top 10 (2025)** dan ke
**Trust Services Criteria SOC 2**, lalu mencatat risiko yang diterima dan hal yang
harus dipenuhi di luar kode. Bukti otomatis: `npm test`.

## Arsitektur singkat

- Permukaan publik: satu halaman statis + `POST /api/rfq` + `/healthz`. Tidak ada login,
  cookie, atau dashboard admin di website, jadi tidak ada sesi yang bisa dicuri.
- Staf bekerja lewat konsol Supabase/Neon, yang sudah punya akun per orang, MFA, dan log akses.
- Server memakai role database `gibs_app` yang hanya bisa menambah RFQ (lihat `db/app-role.sql`).

## OWASP Top 10 (2025)

| Risiko | Kontrol | Lokasi |
|---|---|---|
| A01 Broken Access Control | File statis lewat allowlist eksplisit; `.env`, kode, `data/`, `node_modules` tidak bisa diakses; path traversal tidak mungkin karena path tidak pernah diambil dari URL apa adanya. Role DB `gibs_app` tanpa hak baca nama/WA, ubah, hapus, atau DDL. RLS aktif di semua tabel. Schema `gibs` tidak terbuka ke Data API Supabase. | `server.js` `resolveStatic`, `db/app-role.sql`, migrasi 001 |
| A02 Security Misconfiguration | CSP ketat, `frame-ancestors 'none'`, HSTS (bila https), `nosniff`, Referrer-Policy, Permissions-Policy, COOP/CORP. Mode produksi menolak start tanpa HTTPS origin, DATABASE_URL, dan secret. Pesan error ke pengguna generik + `reqId`. | `server.js` `securityHeaders`, `lib/config.js` |
| A03 Software Supply Chain Failures | Tidak ada skrip/font dari CDN; React, GSAP, Lenis, font di-host sendiri dari npm dengan versi persis (`--save-exact`) + `package-lock.json`. Hash React lokal identik dengan SRI di runtime. `npm run audit` untuk CI. | `package.json`, `vendor/dc-resources.js` |
| A04 Cryptographic Failures | TLS ke database selalu diverifikasi (`rejectUnauthorized: true`, CA Supabase via `DATABASE_CA_CERT`). Data at rest dienkripsi oleh provider (AES-256). IP di log berupa HMAC-SHA256 ber-kunci, bukan IP asli. HTTPS + HSTS di depan server. | `lib/db.js`, `server.js` |
| A05 Injection | Semua query berparameter. Input dinormalisasi (Unicode NFC, karakter kontrol dan bidi dibuang) dan dibatasi panjang. Nama/satuan produk diambil dari katalog server, bukan dari browser. CHECK constraint di database sebagai lapisan kedua. React meng-escape output; dokumen cetak meng-escape manual. | `lib/rfq.js`, migrasi 001 |
| A06 Insecure Design | Rate limit per IP (8 RFQ / 10 menit, termasuk kiriman tidak valid) + batas global per jam + 300 request/menit per IP; map rate limit berukuran tetap. Kunci idempotensi mencegah tiket ganda. Body maks. 32 KB; timeout request/header. | `server.js`, `lib/rfq.js` |
| A07 Authentication Failures | Tidak ada autentikasi di website (permukaan dihilangkan). Akses data hanya lewat konsol provider dengan akun per staf + MFA (wajib diaktifkan, lihat bawah). Kredensial DB terpisah: admin hanya untuk migrasi/DSR, server memakai role terbatas. | README, `db/app-role.sql` |
| A08 Software or Data Integrity Failures | Audit log append-only (UPDATE/DELETE/TRUNCATE ditolak trigger). Kolom tiket, waktu, dan persetujuan tidak bisa diubah; data yang sudah dianonimkan tidak bisa diisi ulang. Migrasi berurutan, dicatat, dan dikunci advisory lock. | migrasi 001, `lib/db.js` |
| A09 Security Logging and Alerting Failures | Log JSON per request (`reqId`, status, durasi, IP ter-hash); `rate_limited`, `health_db_failed`, `unhandled` sebagai sinyal alert. Audit log database mencatat setiap perubahan RFQ dari aplikasi maupun konsol, tanpa menyalin data pribadi. | `server.js`, `gibs.audit_log` |
| A10 Mishandling of Exceptional Conditions | Error tak terduga → 500 generik, detail hanya di log. `unhandledRejection` → log fatal + exit (proses dimulai ulang oleh supervisor). Error pool DB ditangani tanpa crash. Port bentrok dan konfigurasi salah gagal dengan pesan jelas. Transaksi di-rollback saat gagal. | `server.js`, `lib/db.js` |

### Risiko yang diterima

- **CSP `'unsafe-eval'`**: runtime dc (`support.js`) mengompilasi logika halaman dengan
  `new Function`. Sumber yang dikompilasi hanya file halaman ini, tidak pernah input
  pengguna. Hilang bila halaman di-build menjadi JavaScript biasa.
- **`style-src 'unsafe-inline'`**: halaman memakai style inline di seluruh template.
- **Rate limit di memori**: cukup untuk satu proses. Bila server dijalankan lebih dari
  satu instance, pindahkan ke rate limit di reverse proxy atau database.
- **Foto Unsplash dan Google Maps** dimuat dari pihak ketiga (tercantum di kebijakan privasi).
  Ganti foto dengan milik GIBS agar `img-src` bisa dipersempit ke `'self'`.

## Kontrol SOC 2

SOC 2 adalah laporan audit atas organisasi, bukan fitur kode. Kode ini menyediakan
kontrol teknis berikut sebagai bukti; kebijakan dan proses di bagian berikutnya tetap
harus dijalankan GIBS dan diaudit oleh auditor independen.

| Kriteria | Kontrol teknis |
|---|---|
| CC6.1 Akses logis | Role DB least-privilege, RLS, schema non-publik, allowlist file statis |
| CC6.6 Batas sistem | Satu endpoint tulis publik, Origin check, rate limit, CSP |
| CC6.7 Transmisi | HTTPS + HSTS, TLS terverifikasi ke database |
| CC7.2 Pemantauan | Log terstruktur dengan `reqId`, `/healthz`, audit log DB |
| CC7.3–7.5 Insiden | Prosedur di bawah, notifikasi 3×24 jam (UU PDP) |
| CC8.1 Perubahan | Migrasi berversi, tes otomatis (`npm test`), dependensi terkunci |
| A1.2 Ketersediaan | Backup/PITR provider, health check, restart otomatis |
| C1.2 Pembuangan | Anonimisasi otomatis setelah `RETENTION_MONTHS` |
| P (Privasi) | Persetujuan berversi tersimpan per RFQ, pemberitahuan privasi, prosedur DSR (`npm run dsr`) |

### Wajib dipenuhi di luar kode

1. Akun Supabase/Neon per staf, **MFA wajib**, peran sesuai tugas; cabut akses saat staf keluar.
2. Aktifkan backup / point-in-time recovery di provider; uji restore minimal tiap 6 bulan.
3. Simpan `.env` hanya di server; rotasi kata sandi `gibs_app` dan `IP_HASH_SECRET` bila bocor atau staf teknis berganti.
4. Kirim log server ke penyimpanan terpusat dengan alert untuk `level: error/fatal` dan lonjakan `rate_limited`.
5. Jalankan `npm test` dan `npm run audit` sebelum setiap rilis; catat siapa merilis apa.
6. Kebijakan tertulis: kontrol akses, manajemen perubahan, respons insiden, vendor (Supabase/Neon punya laporan SOC 2 Type II sendiri; minta dan arsipkan).
7. Isi `SECURITY_CONTACT` agar `/.well-known/security.txt` aktif.

## Respons insiden

1. **Deteksi**: alert log, laporan pengguna, atau notifikasi provider.
2. **Batasi**: ganti kata sandi `gibs_app` di database, rotasi secret, blokir IP di reverse proxy bila perlu.
3. **Telusuri**: `gibs.audit_log` (siapa, kapan, kolom apa), log server berdasarkan `reqId`, log akses konsol provider.
4. **Beri tahu**: bila data pribadi terdampak, beri tahu subjek data dan lembaga PDP **paling lambat 3×24 jam** secara tertulis (UU 27/2022 pasal 46): data apa, kapan dan bagaimana bocor, upaya penanganan.
5. **Pulihkan dan catat**: perbaiki penyebab, tambah tes, simpan laporan insiden.
