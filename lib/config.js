"use strict";
/* Konfigurasi dari environment. Di produksi (NODE_ENV=production) nilai yang
   tidak aman membuat server menolak start, bukan berjalan diam-diam. */

const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function load(env = process.env) {
  const production = env.NODE_ENV === "production";
  const cfg = {
    production,
    root: ROOT,
    port: Number(env.PORT || 3000),
    host: env.HOST || "127.0.0.1",
    databaseUrl: env.DATABASE_URL || "",
    databaseAdminUrl: env.DATABASE_ADMIN_URL || env.DATABASE_URL || "",
    databaseCaCert: env.DATABASE_CA_CERT || "",
    localDbDir: env.LOCAL_DB_DIR || path.join(ROOT, "data", "pglite"),
    autoMigrate: env.AUTO_MIGRATE ? env.AUTO_MIGRATE === "1" : !production,
    publicOrigin: (env.PUBLIC_ORIGIN || "").replace(/\/+$/, ""),
    trustProxy: env.TRUST_PROXY === "1",
    waNumber: (env.WA_NUMBER || "").replace(/\D/g, ""),
    ipHashSecret: env.IP_HASH_SECRET || "",
    retentionMonths: Number(env.RETENTION_MONTHS || 24),
    securityContact: env.SECURITY_CONTACT || "",
    maxBody: 32 * 1024,
  };

  const problems = [];
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) problems.push("PORT tidak valid");
  if (!Number.isInteger(cfg.retentionMonths) || cfg.retentionMonths < 1 || cfg.retentionMonths > 120)
    problems.push("RETENTION_MONTHS harus 1–120");
  if (cfg.publicOrigin && !/^https?:\/\/[^/\s]+$/.test(cfg.publicOrigin)) problems.push("PUBLIC_ORIGIN harus berupa origin, mis. https://gibs.co.id");
  if (production) {
    if (!cfg.databaseUrl) problems.push("DATABASE_URL wajib di produksi (Supabase atau Neon)");
    if (!cfg.publicOrigin.startsWith("https://")) problems.push("PUBLIC_ORIGIN wajib https:// di produksi");
    if (cfg.ipHashSecret.length < 32) problems.push("IP_HASH_SECRET wajib, minimal 32 karakter acak");
  }
  if (!cfg.ipHashSecret) cfg.ipHashSecret = "dev-only-not-secret";
  return { cfg, problems };
}

module.exports = { load, ROOT };
