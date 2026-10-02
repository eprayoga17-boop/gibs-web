#!/usr/bin/env node
/* Permintaan subjek data (UU PDP pasal 5-13): akses dan penghapusan.
   Verifikasi identitas dulu (pesan datang dari nomor WhatsApp yang sama), lalu:

     npm run dsr -- export 081234567890 --by "Nama Petugas"
     npm run dsr -- erase  081234567890 --by "Nama Petugas" --confirm

   `export` mencetak JSON untuk dikirim ke pemohon. `erase` menganonimkan semua
   permintaan dari nomor itu. Keduanya tercatat di gibs.audit_log atas nama petugas. */
"use strict";
const config = require("../lib/config");
const dbm = require("../lib/db");
const { findByWhatsapp, eraseByWhatsapp } = require("../lib/rfq");

const log = (level, msg, extra = {}) => console.error(JSON.stringify({ level, msg, ...extra }));

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--by") out.by = argv[++i];
    else if (argv[i] === "--confirm") out.confirm = true;
    else out._.push(argv[i]);
  }
  return out;
}

(async () => {
  const a = args(process.argv.slice(2));
  const [cmd, phone] = a._;
  const by = String(a.by || "").trim().replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 40);
  if (!["export", "erase"].includes(cmd) || !phone || !by) {
    console.error('Pakai: npm run dsr -- export|erase <nomor-wa> --by "Nama Petugas" [--confirm]');
    process.exit(2);
  }
  if (cmd === "erase" && !a.confirm) {
    console.error("Tambahkan --confirm untuk menganonimkan data. Tindakan ini tidak bisa dibatalkan.");
    process.exit(2);
  }
  const { cfg } = config.load();
  const db = await dbm.connect(cfg, log, { admin: true });
  try {
    if (cmd === "export") {
      const rows = await findByWhatsapp(db, phone, by);
      console.log(JSON.stringify({ generated_at: new Date().toISOString(), count: rows.length, requests: rows }, null, 2));
    } else {
      const tickets = await eraseByWhatsapp(db, phone, by);
      console.log(JSON.stringify({ anonymized: tickets.length, tickets }, null, 2));
    }
  } finally {
    await db.close();
  }
})().catch(e => { log("fatal", "dsr_failed", { err: e.message }); process.exit(1); });
