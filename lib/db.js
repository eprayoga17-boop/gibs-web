"use strict";
/* Akses database. Satu antarmuka kecil untuk dua backend:
     - Postgres sungguhan (Supabase / Neon) lewat DATABASE_URL, TLS wajib terverifikasi.
     - PGlite (Postgres di dalam proses) untuk pengembangan lokal bila DATABASE_URL kosong.
   Semua query memakai parameter ($1, $2, …); tidak ada SQL yang dirangkai dari input. */

const fs = require("node:fs");
const path = require("node:path");

const MIGRATIONS_DIR = path.join(__dirname, "..", "db", "migrations");
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function pgConfig(url, caCertPath) {
  const u = new URL(url);
  // Parameter ssl* di URL akan menimpa objek ssl di bawah (perilaku pg), jadi dibuang
  // dan TLS diatur eksplisit: selalu terverifikasi kecuali ke database lokal.
  for (const k of [...u.searchParams.keys()]) if (k.startsWith("ssl")) u.searchParams.delete(k);
  const local = LOCAL_HOSTS.has(u.hostname);
  const ssl = local ? false : { rejectUnauthorized: true, ...(caCertPath ? { ca: fs.readFileSync(caCertPath, "utf8") } : {}) };
  return {
    connectionString: u.toString(),
    ssl,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 5000,
    query_timeout: 8000,
    application_name: "gibs-web",
  };
}

async function connectPostgres(url, caCertPath, log) {
  const { Pool } = require("pg");
  const pool = new Pool(pgConfig(url, caCertPath));
  pool.on("error", e => log("error", "db_pool_error", { err: e.message })); // koneksi idle putus: jangan crash
  return {
    kind: "postgres",
    async query(text, params = []) { return (await pool.query(text, params)).rows; },
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const out = await fn({
          query: async (t, p = []) => (await c.query(t, p)).rows,
          exec: t => c.query(t),
        });
        await c.query("COMMIT");
        return out;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

async function connectLocal(dir) {
  let PGlite;
  try { ({ PGlite } = await import("@electric-sql/pglite")); }
  catch { throw new Error("DATABASE_URL kosong dan PGlite tidak terpasang. Isi DATABASE_URL (Supabase/Neon) atau jalankan `npm install`."); }
  if (dir !== "memory://") fs.mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir);
  await db.waitReady;
  return {
    kind: "pglite",
    async query(text, params = []) { return (await db.query(text, params)).rows; },
    tx(fn) {
      return db.transaction(t => fn({
        query: async (q, p = []) => (await t.query(q, p)).rows,
        exec: q => t.exec(q),
      }));
    },
    close: () => db.close(),
  };
}

async function connect(cfg, log, { admin = false } = {}) {
  const url = admin ? cfg.databaseAdminUrl : cfg.databaseUrl;
  if (url) return connectPostgres(url, cfg.databaseCaCert, log);
  if (cfg.production) throw new Error("DATABASE_URL wajib di produksi");
  return connectLocal(cfg.localDbDir);
}

/* ---------------- migrasi ---------------- */
function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
}

async function appliedMigrations(db) {
  const exists = await db.query("SELECT to_regclass('gibs.schema_migrations') AS t");
  if (!exists[0].t) return new Set();
  return new Set((await db.query("SELECT version FROM gibs.schema_migrations")).map(r => r.version));
}

async function pendingMigrations(db) {
  const done = await appliedMigrations(db);
  return migrationFiles().filter(f => !done.has(f));
}

async function migrate(db, log) {
  const applied = [];
  for (const file of migrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const ran = await db.tx(async t => {
      await t.query("SELECT pg_advisory_xact_lock(724001)"); // satu migrator dalam satu waktu
      await t.exec("CREATE SCHEMA IF NOT EXISTS gibs; CREATE TABLE IF NOT EXISTS gibs.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const seen = await t.query("SELECT 1 FROM gibs.schema_migrations WHERE version = $1", [file]);
      if (seen.length) return false;
      await t.exec(sql);
      await t.query("INSERT INTO gibs.schema_migrations (version) VALUES ($1)", [file]);
      return true;
    });
    if (ran) { applied.push(file); log("info", "migration_applied", { file }); }
  }
  return applied;
}

module.exports = { connect, migrate, pendingMigrations, pgConfig };
