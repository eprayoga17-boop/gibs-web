-- Role database khusus aplikasi (least privilege). Jalankan SEKALI sebagai pemilik
-- database, SETELAH `npm run migrate`, lalu pakai role ini di DATABASE_URL.
--
--   Supabase: SQL Editor -> tempel file ini -> ganti kata sandi -> Run.
--   Neon:     SQL Editor (atau psql) dengan role pemilik -> tempel -> Run.
--
-- Role ini hanya bisa: menambah RFQ baru, membaca kolom yang dibutuhkan untuk
-- mencegah kiriman ganda, dan menjalankan anonimisasi retensi. Tidak bisa membaca
-- nama/WhatsApp/catatan, mengubah atau menghapus data, mengubah skema, atau
-- menulis audit log secara langsung.

CREATE ROLE gibs_app LOGIN PASSWORD 'GANTI-DENGAN-KATA-SANDI-ACAK-MINIMAL-32-KARAKTER' NOINHERIT;

GRANT USAGE ON SCHEMA gibs TO gibs_app;
GRANT USAGE ON SEQUENCE gibs.rfq_ticket_seq TO gibs_app;

GRANT INSERT ON gibs.rfq TO gibs_app;
GRANT SELECT (ticket, idempotency_key, created_at) ON gibs.rfq TO gibs_app;

CREATE POLICY gibs_app_insert ON gibs.rfq FOR INSERT TO gibs_app
  WITH CHECK (anonymized_at IS NULL AND status = 'baru');
CREATE POLICY gibs_app_select ON gibs.rfq FOR SELECT TO gibs_app
  USING (true);

GRANT EXECUTE ON FUNCTION gibs.anonymize_expired(integer) TO gibs_app;
