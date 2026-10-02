"use strict";
/* Permintaan penawaran: validasi, simpan, anonimisasi (retensi & hak subjek data). */

const { PRODUCTS, AREAS } = require("./catalog");

// Naikkan bila isi kebijakan privasi di halaman berubah; harus sama dengan PRIVACY_VERSION di halaman.
const PRIVACY_VERSION = "2026-10";

const BUYER = ["Kontraktor", "Toko bangunan", "Perorangan"];
const PAY = ["COD", "Transfer", "Diskusikan dengan sales"];
const PRODUCT_BY_ID = new Map(PRODUCTS.map(p => [p.id, p]));

class HttpError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status; this.code = code; this.fields = fields;
  }
}

/* Teks bebas: normalisasi Unicode, buang karakter kontrol, potong panjang. */
function text(v, max, { multiline = false } = {}) {
  if (typeof v !== "string") return "";
  const ctrl = multiline ? /[\u0000-\u0009\u000B-\u001F\u007F‪-‮⁦-⁩]/g : /[\u0000-\u001F\u007F‪-‮⁦-⁩]/g;
  return v.normalize("NFC").replace(ctrl, "").trim().slice(0, max);
}

/* Nomor WhatsApp Indonesia ke format 62…; null bila tidak masuk akal. */
function normalizeWhatsapp(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "62" + d.slice(1);
  else if (d.startsWith("8")) d = "62" + d;
  return /^62[0-9]{8,14}$/.test(d) ? d : null;
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(+d) || d.toISOString().slice(0, 10) !== s) return false;
  const now = Date.now();
  return +d >= now - 2 * 864e5 && +d <= now + 400 * 864e5;
}

function validateRfq(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "invalid_input", "Format data tidak dikenali.");
  const f = {};
  const name = text(b.name, 80);
  const whatsapp = normalizeWhatsapp(b.whatsapp);
  const regency = text(b.regency, 40);
  const district = text(b.district, 40);
  if (name.length < 2) f.name = "Isi nama minimal 2 huruf.";
  if (!whatsapp) f.whatsapp = "Isi nomor WhatsApp yang aktif.";
  if (!BUYER.includes(b.buyer_type)) f.buyer_type = "Pilih jenis pemesan.";
  if (!PAY.includes(b.payment)) f.payment = "Pilih rencana pembayaran.";
  if (!Object.hasOwn(AREAS, regency)) f.regency = "Pilih kabupaten/kota.";
  else if (!AREAS[regency].includes(district)) f.district = "Pilih kecamatan.";
  const needed = text(b.needed_on, 10);
  if (needed && !validDate(needed)) f.needed_on = "Tanggal tidak valid.";
  if (b.consent !== true) f.consent = "Centang persetujuan pemrosesan data untuk melanjutkan.";
  else if (b.consent_version !== PRIVACY_VERSION) f.consent = "Kebijakan privasi sudah diperbarui. Muat ulang halaman lalu kirim lagi.";
  const key = text(b.idempotency_key, 64);
  if (!/^[A-Za-z0-9-]{16,64}$/.test(key)) f.idempotency_key = "Kunci pengiriman tidak valid.";

  const items = [];
  if (!Array.isArray(b.items) || b.items.length < 1) f.items = "Tambahkan minimal satu produk.";
  else if (b.items.length > 40) f.items = "Maksimal 40 produk per permintaan.";
  else {
    const seen = new Set();
    for (const it of b.items) {
      const p = it && typeof it.id === "string" ? PRODUCT_BY_ID.get(it.id) : undefined;
      const qty = it ? Number(it.qty) : NaN;
      if (!p || seen.has(p.id) || !Number.isInteger(qty) || qty < 1 || qty > 100000) { f.items = "Ada produk atau jumlah yang tidak valid."; break; }
      seen.add(p.id);
      items.push({ id: p.id, name: p.name, unit: p.unit, cat: p.cat, qty, note: text(it.note, 120) });
    }
  }
  if (Object.keys(f).length) throw new HttpError(400, "invalid_input", "Periksa kembali isian formulir.", f);
  return {
    key, name, whatsapp, regency, district, buyer_type: b.buyer_type, payment: b.payment,
    project: text(b.project, 120), note: text(b.note, 600, { multiline: true }), needed_on: needed || null, items,
  };
}

/* Simpan RFQ. Kunci idempotensi yang sama mengembalikan tiket yang sama (klik dua kali, kirim ulang). */
async function createRfq(db, v, actor = "website") {
  return db.tx(async t => {
    await t.query("SELECT set_config('gibs.actor', $1, true)", [actor]);
    const ins = await t.query(
      `INSERT INTO gibs.rfq (idempotency_key, buyer_type, name, whatsapp, project, regency, district,
                             needed_on, payment, note, items, consent_version, consent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12, now())
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ticket, created_at`,
      [v.key, v.buyer_type, v.name, v.whatsapp, v.project, v.regency, v.district,
       v.needed_on, v.payment, v.note, JSON.stringify(v.items), PRIVACY_VERSION]);
    if (ins.length) return { ticket: ins[0].ticket, created_at: ins[0].created_at, replay: false };
    const old = await t.query("SELECT ticket, created_at FROM gibs.rfq WHERE idempotency_key = $1", [v.key]);
    return { ticket: old[0].ticket, created_at: old[0].created_at, replay: true };
  });
}

/* Retensi: anonimkan RFQ yang lebih tua dari N bulan (logika di gibs.anonymize_expired). */
async function anonymizeExpired(db, months) {
  return db.tx(async t => {
    await t.query("SELECT set_config('gibs.actor', 'retention', true)");
    const r = await t.query("SELECT gibs.anonymize_expired($1::int) AS n", [months]);
    return r[0].n;
  });
}

/* Hak subjek data (UU PDP): akses dan penghapusan berdasarkan nomor WhatsApp. */
async function findByWhatsapp(db, raw, operator) {
  const wa = normalizeWhatsapp(raw);
  if (!wa) throw new Error("Nomor WhatsApp tidak valid");
  return db.tx(async t => {
    await t.query("SELECT set_config('gibs.actor', $1, true)", ["dsr:" + operator]);
    const rows = await t.query(
      `SELECT ticket, created_at, status, buyer_type, name, whatsapp, project, regency, district,
              needed_on, payment, note, items, consent_version, consent_at
         FROM gibs.rfq WHERE whatsapp = $1 AND anonymized_at IS NULL ORDER BY created_at`, [wa]);
    await t.query(
      `INSERT INTO gibs.audit_log (actor, action, entity, entity_ref, detail)
       VALUES (gibs.current_actor(), 'dsr.access', 'rfq', NULL, jsonb_build_object('rows', $1::int))`, [rows.length]);
    return rows;
  });
}

async function eraseByWhatsapp(db, raw, operator) {
  const wa = normalizeWhatsapp(raw);
  if (!wa) throw new Error("Nomor WhatsApp tidak valid");
  return db.tx(async t => {
    await t.query("SELECT set_config('gibs.actor', $1, true)", ["dsr:" + operator]);
    const rows = await t.query("SELECT gibs.anonymize_by_whatsapp($1) AS ticket", [wa]);
    return rows.map(r => r.ticket);
  });
}

module.exports = {
  PRIVACY_VERSION, HttpError, validateRfq, createRfq, anonymizeExpired,
  findByWhatsapp, eraseByWhatsapp, normalizeWhatsapp,
};
