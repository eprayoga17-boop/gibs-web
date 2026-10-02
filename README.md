# Website GIBS

Website PT Global Indo Buana Sentosa. Halaman satu-satunya adalah **`GIBS Site.dc.html`**,
disajikan di `/`. Formulir "Daftar penawaran" mengirim ke `POST /api/rfq` dan tersimpan di
Postgres (**Supabase** atau **Neon**).

```
GIBS Site.dc.html     halaman (beranda, produk, penawaran, area, tentang, kontak, privasi)
support.js            runtime halaman dc (hasil generate, jangan diedit)
assets/               logo
server.js             server HTTP: file statis (allowlist), header keamanan, API RFQ
lib/                  konfigurasi, koneksi database, validasi RFQ, katalog untuk validasi
db/migrations/        skema database (tabel, trigger audit, anonimisasi, RLS)
db/app-role.sql       role database least-privilege untuk server
scripts/              migrate, dsr (hak subjek data), retention
test/                 tes keamanan dan fungsi (npm test)
vendor/               pemetaan React lokal untuk runtime dc
SECURITY.md           OWASP Top 10 + kontrol SOC 2 + respons insiden
PRIVACY.md            kepatuhan UU PDP: catatan pemrosesan, retensi, prosedur hak subjek data
```

## Menjalankan di komputer sendiri

Butuh Node.js 22.9 atau lebih baru.

```bash
npm install
npm start
```

Buka http://127.0.0.1:3000. Tanpa `DATABASE_URL`, data tersimpan di Postgres lokal
(PGlite) di `data/pglite`, jadi bisa dicoba tanpa akun cloud. Jangan jalankan
`npm run dsr` saat server lokal masih hidup (PGlite hanya boleh dibuka satu proses).

Bila muncul `port 3000 sudah dipakai`, server versi lama masih jalan di terminal lain:
hentikan dengan Ctrl+C di sana, lalu `npm start` lagi.

## Menyambungkan ke Supabase atau Neon

Kode memakai Postgres biasa (`pg`), jadi keduanya bisa. Pilih wilayah **Singapore
(ap-southeast-1)**, yang terdekat ke Lombok.

**Neon**
1. Buat project, salin connection string role pemilik (pakai host `-pooler`).
2. Isi `.env`: `DATABASE_ADMIN_URL=<string itu>`.

**Supabase**
1. Buat project. Di *Connect*, salin string **Session pooler** (port 5432).
2. Unduh sertifikat di *Project Settings > Database > SSL Configuration*, simpan di
   luar folder publik, isi `DATABASE_CA_CERT=<path file .crt>`.
3. Isi `.env`: `DATABASE_ADMIN_URL=<string itu>`.

Lalu, untuk keduanya:

```bash
npm run migrate                        # buat tabel di schema gibs
```

4. Buka SQL Editor, tempel `db/app-role.sql`, ganti kata sandinya, Run.
5. Isi `DATABASE_URL` dengan string yang sama tetapi user `gibs_app` + kata sandi tadi
   (Supabase: `gibs_app.<project-ref>`). Server hanya memakai role ini.
6. `npm start`. Log harus menampilkan `"db":"postgres"`.

Tim sales melihat dan mengubah status permintaan di **Table Editor** Supabase/Neon,
schema `gibs`, tabel `rfq` (status: baru, dihitung, terkirim, deal, batal). Setiap
perubahan otomatis tercatat di `gibs.audit_log`. Beri tiap staf akun sendiri di
organisasi Supabase/Neon dan wajibkan MFA (lihat SECURITY.md).

## Produksi

Isi `.env` dari `.env.example` dengan `NODE_ENV=production`, `PUBLIC_ORIGIN=https://…`,
`IP_HASH_SECRET`, `TRUST_PROXY=1`, dan `DATABASE_URL` role `gibs_app`. Server menolak
start bila salah satunya tidak aman. Pasang di belakang reverse proxy HTTPS, contoh Caddy:

```
gibs.domainanda.com {
  reverse_proxy 127.0.0.1:3000
}
```

Instal dengan `npm ci --omit=dev` (PGlite tidak ikut terpasang). Jalankan
`npm run migrate` setiap ada migrasi baru sebelum restart server. Pantau `GET /healthz`.

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm start` | jalankan server (memuat `.env`) |
| `npm test` | tes keamanan dan fungsi, memakai database in-memory |
| `npm run migrate` | terapkan migrasi dengan `DATABASE_ADMIN_URL` |
| `npm run dsr -- export <wa> --by "Nama"` | salinan data untuk pemohon (UU PDP) |
| `npm run dsr -- erase <wa> --by "Nama" --confirm` | anonimkan data pemohon |
| `npm run retention` | anonimkan data lewat masa simpan sekarang (otomatis tiap 24 jam) |
| `npm run audit` | cek kerentanan dependensi |

## Mengubah halaman

Katalog produk dan wilayah ada di dua tempat: `GIBS Site.dc.html` (tampilan) dan
`lib/catalog.js` (validasi server). `npm test` gagal bila keduanya berbeda. Bila isi
kebijakan privasi di halaman berubah, naikkan `PRIVACY_VERSION` di halaman **dan** di
`lib/rfq.js`.
