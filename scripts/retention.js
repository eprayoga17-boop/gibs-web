#!/usr/bin/env node
/* Jalankan anonimisasi retensi sekarang (server juga menjalankannya otomatis tiap 24 jam). */
"use strict";
const config = require("../lib/config");
const dbm = require("../lib/db");
const { anonymizeExpired } = require("../lib/rfq");

const log = (level, msg, extra = {}) => console.log(JSON.stringify({ level, msg, ...extra }));

(async () => {
  const { cfg } = config.load();
  const db = await dbm.connect(cfg, log);
  try {
    const n = await anonymizeExpired(db, cfg.retentionMonths);
    log("info", "retention_done", { anonymized: n, months: cfg.retentionMonths });
  } finally {
    await db.close();
  }
})().catch(e => { log("fatal", "retention_failed", { err: e.message }); process.exit(1); });
