-- GIBS: skema awal. Kompatibel dengan Supabase, Neon, dan Postgres biasa (>= 14).
-- Semua tabel di schema `gibs`, bukan `public`, supaya tidak ikut terbuka lewat
-- Data API Supabase (PostgREST) yang secara default hanya melayani `public`.

CREATE SCHEMA IF NOT EXISTS gibs;
REVOKE ALL ON SCHEMA gibs FROM PUBLIC;

/* ------------------------------------------------------------------ */
/* Permintaan penawaran (RFQ)                                           */
/* ------------------------------------------------------------------ */
CREATE SEQUENCE gibs.rfq_ticket_seq;

CREATE TABLE gibs.rfq (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket           text        NOT NULL UNIQUE,              -- diisi trigger
  idempotency_key  text        NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9-]{16,64}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  status           text        NOT NULL DEFAULT 'baru'
                   CHECK (status IN ('baru','dihitung','terkirim','deal','batal')),
  buyer_type       text        NOT NULL CHECK (buyer_type IN ('Kontraktor','Toko bangunan','Perorangan')),
  name             text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  whatsapp         text        NOT NULL,                     -- digit saja, format 62…
  project          text        NOT NULL DEFAULT '' CHECK (char_length(project) <= 120),
  regency          text        NOT NULL CHECK (char_length(regency) BETWEEN 1 AND 40),
  district         text        NOT NULL CHECK (char_length(district) BETWEEN 1 AND 40),
  needed_on        date,
  payment          text        NOT NULL CHECK (payment IN ('COD','Transfer','Diskusikan dengan sales')),
  note             text        NOT NULL DEFAULT '' CHECK (char_length(note) <= 600),
  items            jsonb       NOT NULL
                   CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 40),
  consent_version  text        NOT NULL CHECK (char_length(consent_version) BETWEEN 1 AND 20),
  consent_at       timestamptz NOT NULL,
  first_reply_at   timestamptz,
  anonymized_at    timestamptz,
  CONSTRAINT rfq_whatsapp_format CHECK (anonymized_at IS NOT NULL OR whatsapp ~ '^62[0-9]{8,14}$'),
  CONSTRAINT rfq_name_min        CHECK (anonymized_at IS NOT NULL OR char_length(name) >= 2)
);
CREATE INDEX rfq_created_idx  ON gibs.rfq (created_at DESC);
CREATE INDEX rfq_status_idx   ON gibs.rfq (status, created_at DESC);
CREATE INDEX rfq_whatsapp_idx ON gibs.rfq (whatsapp) WHERE anonymized_at IS NULL;

COMMENT ON TABLE gibs.rfq IS
  'Permintaan penawaran dari website. Berisi data pribadi (UU PDP): nama, WhatsApp, catatan. Dianonimkan otomatis setelah masa retensi.';

-- Nomor tiket, kolom yang tidak boleh berubah, dan waktu balasan pertama.
CREATE FUNCTION gibs.rfq_before_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    n := nextval('gibs.rfq_ticket_seq');
    NEW.ticket := 'RFQ-' || to_char(NEW.created_at AT TIME ZONE 'Asia/Makassar', 'YYYY')
                  || '-' || lpad(n::text, greatest(4, length(n::text)), '0');
    RETURN NEW;
  END IF;

  IF OLD.anonymized_at IS NOT NULL THEN
    RAISE EXCEPTION 'rfq % sudah dianonimkan dan tidak bisa diubah', OLD.ticket;
  END IF;
  IF NEW.ticket <> OLD.ticket OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.created_at <> OLD.created_at OR NEW.consent_at <> OLD.consent_at
     OR NEW.consent_version <> OLD.consent_version THEN
    RAISE EXCEPTION 'kolom ticket, idempotency_key, created_at, dan consent_* tidak boleh diubah';
  END IF;
  NEW.updated_at := now();
  IF OLD.status = 'baru' AND NEW.status <> 'baru' AND NEW.first_reply_at IS NULL THEN
    NEW.first_reply_at := now();
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER rfq_before_write
  BEFORE INSERT OR UPDATE ON gibs.rfq
  FOR EACH ROW EXECUTE FUNCTION gibs.rfq_before_write();

/* ------------------------------------------------------------------ */
/* Audit log: append-only, tanpa nilai data pribadi                     */
/* ------------------------------------------------------------------ */
CREATE TABLE gibs.audit_log (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text        NOT NULL,      -- 'website', 'retention', 'dsr:<petugas>', atau role database
  action      text        NOT NULL,
  entity      text        NOT NULL,
  entity_ref  text,
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_at_idx  ON gibs.audit_log (at DESC);
CREATE INDEX audit_log_ref_idx ON gibs.audit_log (entity, entity_ref);

COMMENT ON TABLE gibs.audit_log IS
  'Jejak audit append-only. Mencatat siapa mengubah apa dan kapan (nama kolom, bukan isinya).';

-- Aplikasi menandai pelaku lewat set_config('gibs.actor', …, true).
-- Perubahan dari konsol Supabase/Neon tercatat dengan nama role database-nya.
CREATE FUNCTION gibs.current_actor() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('gibs.actor', true), ''), session_user::text)
$$;

CREATE FUNCTION gibs.audit_rfq() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = gibs, pg_temp AS $$
DECLARE
  changed text[];
  act     text;
  extra   jsonb := '{}'::jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO gibs.audit_log (actor, action, entity, entity_ref, detail)
    VALUES (gibs.current_actor(), 'rfq.create', 'rfq', NEW.ticket,
            jsonb_build_object('items', jsonb_array_length(NEW.items), 'regency', NEW.regency));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT coalesce(array_agg(n.key ORDER BY n.key), '{}') INTO changed
      FROM jsonb_each(to_jsonb(NEW)) n
     WHERE n.key NOT IN ('updated_at', 'first_reply_at')
       AND n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key);
    act := CASE
      WHEN OLD.anonymized_at IS NULL AND NEW.anonymized_at IS NOT NULL THEN 'rfq.anonymize'
      WHEN NEW.status IS DISTINCT FROM OLD.status THEN 'rfq.status'
      ELSE 'rfq.update' END;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      extra := jsonb_build_object('from', OLD.status, 'to', NEW.status);
    END IF;
    INSERT INTO gibs.audit_log (actor, action, entity, entity_ref, detail)
    VALUES (gibs.current_actor(), act, 'rfq', NEW.ticket, jsonb_build_object('changed', to_jsonb(changed)) || extra);
    RETURN NEW;
  ELSE
    INSERT INTO gibs.audit_log (actor, action, entity, entity_ref, detail)
    VALUES (gibs.current_actor(), 'rfq.delete', 'rfq', OLD.ticket, '{}'::jsonb);
    RETURN OLD;
  END IF;
END $$;

CREATE TRIGGER rfq_audit
  AFTER INSERT OR UPDATE OR DELETE ON gibs.rfq
  FOR EACH ROW EXECUTE FUNCTION gibs.audit_rfq();

CREATE FUNCTION gibs.audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'gibs.audit_log hanya boleh ditambah (append-only)';
END $$;

CREATE TRIGGER audit_log_no_change
  BEFORE UPDATE OR DELETE ON gibs.audit_log
  FOR EACH ROW EXECUTE FUNCTION gibs.audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON gibs.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION gibs.audit_log_append_only();

/* ------------------------------------------------------------------ */
/* Anonimisasi (retensi dan hak hapus subjek data UU PDP)               */
/* Nama, WhatsApp, proyek, catatan dikosongkan; produk + jumlah +        */
/* wilayah tetap ada untuk statistik.                                   */
/* ------------------------------------------------------------------ */
CREATE FUNCTION gibs.anonymize_expired(p_months integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = gibs, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF p_months IS NULL OR p_months < 1 THEN
    RAISE EXCEPTION 'p_months harus >= 1';
  END IF;
  UPDATE gibs.rfq
     SET name = '[dihapus]', whatsapp = '', project = '', note = '',
         items = (SELECT coalesce(jsonb_agg(e - 'note'), '[]'::jsonb) FROM jsonb_array_elements(items) e),
         anonymized_at = now()
   WHERE anonymized_at IS NULL
     AND created_at < now() - make_interval(months => p_months);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE FUNCTION gibs.anonymize_by_whatsapp(p_whatsapp text) RETURNS SETOF text
LANGUAGE sql SECURITY DEFINER SET search_path = gibs, pg_temp AS $$
  UPDATE gibs.rfq
     SET name = '[dihapus]', whatsapp = '', project = '', note = '',
         items = (SELECT coalesce(jsonb_agg(e - 'note'), '[]'::jsonb) FROM jsonb_array_elements(items) e),
         anonymized_at = now()
   WHERE whatsapp = p_whatsapp AND anonymized_at IS NULL
  RETURNING ticket
$$;

REVOKE ALL ON FUNCTION gibs.anonymize_expired(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION gibs.anonymize_by_whatsapp(text) FROM PUBLIC;

/* ------------------------------------------------------------------ */
/* Row Level Security: tolak semua role selain pemilik tabel.           */
/* Hak role aplikasi ditambahkan di db/app-role.sql.                    */
/* ------------------------------------------------------------------ */
ALTER TABLE gibs.rfq       ENABLE ROW LEVEL SECURITY;
ALTER TABLE gibs.audit_log ENABLE ROW LEVEL SECURITY;
