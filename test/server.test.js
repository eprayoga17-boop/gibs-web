"use strict";
/* Tes keamanan + fungsi. Database: PGlite in-memory, tidak menyentuh data lokal/cloud. */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../lib/config");
const dbm = require("../lib/db");
const { createApp } = require("../server");
const { anonymizeExpired, findByWhatsapp, eraseByWhatsapp } = require("../lib/rfq");
const { PRODUCTS, AREAS } = require("../lib/catalog");

const silent = () => {};
let db, server, base, cfg;

before(async () => {
  ({ cfg } = config.load({ LOCAL_DB_DIR: "memory://", IP_HASH_SECRET: "x".repeat(32) }));
  db = await dbm.connect(cfg, silent);
  await dbm.migrate(db, silent);
  server = createApp({ cfg, db, log: silent, limits: { rfqPerIp: 1000 } });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.close(); });

let n = 0;
const body = (over = {}) => ({
  idempotency_key: `test-key-${Date.now()}-${++n}`.padEnd(20, "0"),
  buyer_type: "Kontraktor", name: "Uji Coba", whatsapp: "0812 3456 7890",
  regency: "Kota Mataram", district: "Ampenan", payment: "COD",
  consent: true, consent_version: "2026-10",
  items: [{ id: "b1", qty: 20, note: "ukuran 6" }], ...over,
});
const post = (b, headers = {}) => fetch(base + "/api/rfq", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: base, ...headers },
  body: typeof b === "string" ? b : JSON.stringify(b),
});

test("halaman / adalah GIBS Site.dc.html dengan header keamanan", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes("<x-dc>") && html.includes("Kebijakan privasi"));
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.ok(!/unpkg|jsdelivr|googleapis/.test(html), "tidak ada skrip/font dari CDN pihak ketiga");
});

test("file server, rahasia, dan path traversal tidak bisa diakses", async () => {
  for (const p of ["/.env", "/.env.example", "/server.js", "/package.json", "/lib/config.js", "/db/app-role.sql",
    "/assets/../.env", "/assets/%2e%2e/.env", "/vendor/fonts/archivo/../../../.env", "/data/pglite",
    "/node_modules/react/package.json", "/GIBS%20Home.dc.html", "/uploads/gibs-web-alpha/.env.example"]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 404, p);
  }
});

test("RFQ tersimpan, tiket berformat, kirim ulang tidak membuat duplikat", async () => {
  const b = body();
  const r1 = await post(b);
  assert.equal(r1.status, 201);
  const j1 = await r1.json();
  assert.match(j1.ticket, /^RFQ-\d{4}-\d{4,}$/);
  const r2 = await post(b);
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).ticket, j1.ticket);
  const rows = await db.query("SELECT name, whatsapp, items FROM gibs.rfq WHERE ticket = $1", [j1.ticket]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].whatsapp, "6281234567890");
  assert.equal(rows[0].items[0].name, PRODUCTS[0].name, "nama produk dari katalog server, bukan dari browser");
});

test("validasi: persetujuan, produk palsu, jumlah, versi privasi", async () => {
  const cases = [
    [{ consent: false }, "consent"],
    [{ consent_version: "1999-01" }, "consent"],
    [{ items: [{ id: "zz", qty: 1 }] }, "items"],
    [{ items: [{ id: "b1", qty: -5 }] }, "items"],
    [{ items: [{ id: "b1", qty: 1 }, { id: "b1", qty: 2 }] }, "items"],
    [{ whatsapp: "123" }, "whatsapp"],
    [{ regency: "Kota Mataram", district: "Gerung" }, "district"],
    [{ regency: "__proto__" }, "regency"],
    [{ buyer_type: "Admin" }, "buyer_type"],
    [{ needed_on: "2026-02-31" }, "needed_on"],
  ];
  for (const [over, field] of cases) {
    const r = await post(body(over));
    assert.equal(r.status, 400, JSON.stringify(over));
    const j = await r.json();
    assert.ok(j.error.fields[field], `${field} untuk ${JSON.stringify(over)}`);
    assert.ok(!JSON.stringify(j).includes("stack"));
  }
});

test("injeksi SQL tersimpan sebagai teks biasa", async () => {
  const evil = "x'); DROP TABLE gibs.rfq;--";
  const r = await post(body({ name: evil }));
  assert.equal(r.status, 201);
  const { ticket } = await r.json();
  const rows = await db.query("SELECT name FROM gibs.rfq WHERE ticket = $1", [ticket]);
  assert.equal(rows[0].name, evil);
});

test("origin asing, content-type salah, JSON rusak, body besar ditolak", async () => {
  assert.equal((await post(body(), { Origin: "https://evil.example" })).status, 403);
  assert.equal((await post(body(), { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post("{bukan json")).status, 400);
  assert.equal((await post("[]")).status, 400);
  assert.equal((await post("a".repeat(40000))).status, 413);
});

test("rate limit RFQ per IP (juga menghitung kiriman tidak valid)", async () => {
  const s2 = createApp({ cfg, db, log: silent, limits: { rfqPerIp: 3 } });
  await new Promise(r => s2.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${s2.address().port}/api/rfq`;
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body({ consent: i % 2 === 0 })) });
      codes.push(r.status);
      if (r.status === 429) assert.ok(Number(r.headers.get("retry-after")) > 0);
    }
    assert.deepEqual(codes.slice(3), [429, 429]);
  } finally { s2.close(); }
});

test("audit log tercatat dan tidak bisa diubah/dihapus", async () => {
  const rows = await db.query("SELECT actor, action FROM gibs.audit_log WHERE action = 'rfq.create' LIMIT 1");
  assert.equal(rows[0].actor, "website");
  await assert.rejects(db.query("UPDATE gibs.audit_log SET actor = 'x'"), /append-only/);
  await assert.rejects(db.query("DELETE FROM gibs.audit_log"), /append-only/);
  await assert.rejects(db.query("TRUNCATE gibs.audit_log"), /append-only/);
  const all = await db.query("SELECT detail::text AS d FROM gibs.audit_log");
  assert.ok(!all.some(r => r.d.includes("6281234567890") || r.d.includes("Uji Coba")), "audit log tidak menyimpan data pribadi");
});

test("status, kolom terkunci, dan anonimisasi (retensi + hak hapus)", async () => {
  await db.query(`INSERT INTO gibs.rfq (idempotency_key,buyer_type,name,whatsapp,regency,district,payment,items,consent_version,consent_at,created_at)
    VALUES ('old-key-000000000001','Perorangan','Lama Sekali','6281111111111','Lombok Barat','Gerung','COD','[{"id":"k1","qty":3,"note":"rumah pak X"}]','2026-10',now(),now() - interval '30 months')`);
  const [old] = await db.query("SELECT ticket FROM gibs.rfq WHERE idempotency_key = 'old-key-000000000001'");
  await db.query("UPDATE gibs.rfq SET status = 'dihitung' WHERE ticket = $1", [old.ticket]);
  const [s] = await db.query("SELECT first_reply_at FROM gibs.rfq WHERE ticket = $1", [old.ticket]);
  assert.ok(s.first_reply_at);
  await assert.rejects(db.query("UPDATE gibs.rfq SET ticket = 'RFQ-0000-0000' WHERE ticket = $1", [old.ticket]), /tidak boleh diubah/);
  const ev = await db.query("SELECT detail FROM gibs.audit_log WHERE entity_ref = $1 AND action = 'rfq.status'", [old.ticket]);
  assert.deepEqual([ev[0].detail.from, ev[0].detail.to], ["baru", "dihitung"]);

  assert.equal(await anonymizeExpired(db, 24), 1);
  const [a] = await db.query("SELECT name, whatsapp, items, anonymized_at FROM gibs.rfq WHERE ticket = $1", [old.ticket]);
  assert.equal(a.name, "[dihapus]");
  assert.equal(a.whatsapp, "");
  assert.equal(a.items[0].note, undefined);
  assert.equal(a.items[0].qty, 3, "statistik produk tetap");
  await assert.rejects(db.query("UPDATE gibs.rfq SET name = 'kembali' WHERE ticket = $1", [old.ticket]), /dianonimkan/);

  const found = await findByWhatsapp(db, "+62 812-3456-7890", "Petugas Uji");
  assert.ok(found.length >= 1);
  const erased = await eraseByWhatsapp(db, "081234567890", "Petugas Uji");
  assert.equal(erased.length, found.length);
  assert.equal((await findByWhatsapp(db, "081234567890", "Petugas Uji")).length, 0);
  const dsr = await db.query("SELECT actor FROM gibs.audit_log WHERE actor = 'dsr:Petugas Uji'");
  assert.ok(dsr.length >= 2);
});

test("role aplikasi (db/app-role.sql) hanya punya hak minimum", async () => {
  await db.query("SET ROLE NONE").catch(() => {});
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "app-role.sql"), "utf8");
  await db.tx(t => t.exec(sql));
  await db.query("SET ROLE gibs_app");
  try {
    const ins = await db.query(`INSERT INTO gibs.rfq (idempotency_key,buyer_type,name,whatsapp,regency,district,payment,items,consent_version,consent_at)
      VALUES ('role-key-00000000001','Perorangan','Role Uji','6281222333444','Kota Mataram','Ampenan','COD','[{"id":"b1","qty":1}]','2026-10',now())
      RETURNING ticket, created_at`);
    assert.match(ins[0].ticket, /^RFQ-/);
    assert.equal(typeof (await db.query("SELECT gibs.anonymize_expired(24) AS n"))[0].n, "number");
    await assert.rejects(db.query("SELECT name, whatsapp FROM gibs.rfq"), /permission denied/);
    await assert.rejects(db.query("UPDATE gibs.rfq SET status = 'deal'"), /permission denied/);
    await assert.rejects(db.query("DELETE FROM gibs.rfq"), /permission denied/);
    await assert.rejects(db.query("SELECT * FROM gibs.audit_log"), /permission denied/);
    await assert.rejects(db.query("INSERT INTO gibs.audit_log (actor,action,entity) VALUES ('x','x','x')"), /permission denied/);
    await assert.rejects(db.query("SELECT * FROM gibs.anonymize_by_whatsapp('6281234567890')"), /permission denied/);
    await assert.rejects(db.query("CREATE TABLE gibs.x (id int)"), /permission denied/);
  } finally {
    await db.query("RESET ROLE");
  }
});

test("katalog server sama dengan katalog di halaman", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "GIBS Site.dc.html"), "utf8");
  for (const p of PRODUCTS) {
    const re = new RegExp(`id: "${p.id}", cat: "${p.cat}", name: ${JSON.stringify(p.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},[^}]*unit: "${p.unit}"`);
    assert.match(html, re, `produk ${p.id} berbeda dengan halaman`);
  }
  for (const [reg, ds] of Object.entries(AREAS)) {
    assert.ok(html.includes(`"${reg}": {`) && html.includes(`d: ${JSON.stringify(ds).replace(/,/g, ",")}`), `wilayah ${reg} berbeda dengan halaman`);
  }
  assert.ok(html.includes('PRIVACY_VERSION = "2026-10"'));
});
