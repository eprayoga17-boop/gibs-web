#!/usr/bin/env node
/* Terapkan migrasi db/migrations/*.sql. Memakai DATABASE_ADMIN_URL (pemilik database)
   bila ada, karena role aplikasi sengaja tidak punya hak mengubah skema. */
"use strict";
const config = require("../lib/config");
const dbm = require("../lib/db");

const log = (level, msg, extra = {}) => console.log(JSON.stringify({ level, msg, ...extra }));

(async () => {
  const { cfg } = config.load();
  const db = await dbm.connect(cfg, log, { admin: true });
  try {
    const applied = await dbm.migrate(db, log);
    log("info", applied.length ? "migrations_done" : "schema_up_to_date", { applied, db: db.kind });
  } finally {
    await db.close();
  }
})().catch(e => { log("fatal", "migration_failed", { err: e.message }); process.exit(1); });
