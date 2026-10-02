#!/usr/bin/env node
/* =====================================================================
   GIBS: server untuk "GIBS Site.dc.html" + API permintaan penawaran (RFQ)
   Database: Postgres (Supabase atau Neon) lewat DATABASE_URL.
   Tanpa DATABASE_URL (pengembangan lokal) memakai PGlite di ./data/pglite.

   Jalankan:  npm start            (memuat .env)
   Variabel lingkungan: lihat .env.example
   ===================================================================== */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const config = require("./lib/config");
const dbm = require("./lib/db");
const { HttpError, validateRfq, createRfq, anonymizeExpired, PRIVACY_VERSION } = require("./lib/rfq");

function log(level, msg, extra = {}) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }) + "\n");
}

/* ---------------- file statis (allowlist, tidak pernah membaca path dari URL apa adanya) ---------------- */
const ROOT = config.ROOT;
const NM = path.join(ROOT, "node_modules");
const PAGE_FILE = path.join(ROOT, "GIBS Site.dc.html");
const JS = "text/javascript; charset=utf-8";

const STATIC = new Map([
  ["/", [PAGE_FILE, "text/html; charset=utf-8"]],
  ["/index.html", [PAGE_FILE, "text/html; charset=utf-8"]],
  ["/support.js", [path.join(ROOT, "support.js"), JS]],
  ["/favicon.ico", [path.join(ROOT, "assets", "logo-mark.jpg"), "image/jpeg"]],
  ["/vendor/dc-resources.js", [path.join(ROOT, "vendor", "dc-resources.js"), JS]],
  ["/vendor/react.production.min.js", [path.join(NM, "react", "umd", "react.production.min.js"), JS]],
  ["/vendor/react-dom.production.min.js", [path.join(NM, "react-dom", "umd", "react-dom.production.min.js"), JS]],
  ["/vendor/gsap.min.js", [path.join(NM, "gsap", "dist", "gsap.min.js"), JS]],
  ["/vendor/ScrollTrigger.min.js", [path.join(NM, "gsap", "dist", "ScrollTrigger.min.js"), JS]],
  ["/vendor/lenis.min.js", [path.join(NM, "lenis", "dist", "lenis.min.js"), JS]],
]);
const FONT_PKGS = { "archivo": "@fontsource/archivo", "big-shoulders-display": "@fontsource/big-shoulders-display" };
const IMAGE_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif" };

function resolveStatic(p) {
  const hit = STATIC.get(p);
  if (hit) return hit;
  let m = p.match(/^\/assets\/([A-Za-z0-9_-]{1,80}(\.[a-z]{3,4}))$/);
  if (m && IMAGE_TYPES[m[2]]) return [path.join(ROOT, "assets", m[1]), IMAGE_TYPES[m[2]]];
  m = p.match(/^\/vendor\/fonts\/([a-z-]+)\/(\d{3}\.css|files\/[a-z0-9-]{1,80}\.woff2)$/);
  if (m && FONT_PKGS[m[1]]) return [path.join(NM, FONT_PKGS[m[1]], m[2]), m[2].endsWith(".css") ? "text/css; charset=utf-8" : "font/woff2"];
  return null;
}

/* ---------------- header keamanan ---------------- */
function securityHeaders(cfg) {
  const csp = [
    "default-src 'self'",
    // 'unsafe-eval': runtime dc (support.js) mengompilasi logika halaman dengan new Function.
    // Sumbernya hanya file halaman ini sendiri, bukan input pengguna. Lihat SECURITY.md.
    "script-src 'self' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://images.unsplash.com",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src https://maps.google.com https://www.google.com",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(cfg.publicOrigin.startsWith("https://") ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
  return {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...(cfg.publicOrigin.startsWith("https://") ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
  };
}

/* ---------------- rate limit (memori, jendela tetap, ukuran map dibatasi) ---------------- */
function createLimiter(maxKeys = 50000) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (now > b.until) buckets.delete(k);
  }, 60e3);
  timer.unref();
  return {
    hit(key, max, windowMs) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b || now > b.until) {
        if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
        b = { n: 0, until: now + windowMs };
        buckets.set(key, b);
      }
      if (++b.n > max) {
        throw Object.assign(new HttpError(429, "rate_limited", "Terlalu banyak permintaan. Coba lagi beberapa menit lagi."),
          { retryAfter: Math.ceil((b.until - now) / 1000) });
      }
    },
    stop: () => clearInterval(timer),
  };
}

/* ---------------- aplikasi ---------------- */
const DEFAULT_LIMITS = { perIpPerMin: 300, rfqPerIp: 8, rfqWindowMs: 10 * 60e3, rfqGlobalPerHour: 300 };

function createApp({ cfg, db, log: logFn = log, limits = {} }) {
  const log = logFn;
  const L = { ...DEFAULT_LIMITS, ...limits };
  const headers = securityHeaders(cfg);
  const limiter = createLimiter();
  // IP adalah data pribadi: log hanya menyimpan hash ber-kunci, bukan IP asli.
  const ipTag = ip => crypto.createHmac("sha256", cfg.ipHashSecret).update(ip).digest("hex").slice(0, 16);

  function clientIp(req) {
    if (cfg.trustProxy && req.headers["x-forwarded-for"]) return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
    return req.socket.remoteAddress || "?";
  }

  function send(res, status, body, extra = {}) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers, ...extra });
    res.end(JSON.stringify(body));
  }

  function sendText(res, status, body, type = "text/plain; charset=utf-8") {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-cache", ...headers });
    res.end(body);
  }

  function serveStatic(req, res, p) {
    const hit = resolveStatic(p);
    if (!hit) return false;
    const [file, type] = hit;
    fs.readFile(file, (err, buf) => {
      if (err) return sendText(res, 404, "Not found");
      const isHtml = type.startsWith("text/html");
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": buf.length,
        "Cache-Control": isHtml || p === "/support.js" || p === "/vendor/dc-resources.js" ? "no-cache" : "public, max-age=604800",
        ...headers,
      });
      res.end(req.method === "HEAD" ? undefined : buf);
    });
    return true;
  }

  // Permintaan yang mengubah data harus datang dari situs ini sendiri.
  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return; // non-browser (curl); tidak ada cookie/sesi yang bisa disalahgunakan
    const allowed = cfg.publicOrigin || `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`;
    if (origin !== allowed) throw new HttpError(403, "bad_origin", "Asal permintaan tidak dikenali.");
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (type !== "application/json") return reject(new HttpError(415, "unsupported_media_type", "Kirim data dalam format JSON."));
      const declared = Number(req.headers["content-length"] || 0);
      if (declared > cfg.maxBody) return reject(new HttpError(413, "payload_too_large", "Data terlalu besar."));
      let size = 0; const chunks = [];
      req.on("data", c => {
        size += c.length;
        if (size > cfg.maxBody) { reject(new HttpError(413, "payload_too_large", "Data terlalu besar.")); req.destroy(); }
        else chunks.push(c);
      });
      req.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null")); }
        catch { reject(new HttpError(400, "invalid_json", "Format data tidak dikenali.")); }
      });
      req.on("error", reject);
    });
  }

  async function handle(req, res, reqId, ip) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    limiter.hit("all:" + ip, L.perIpPerMin, 60e3);

    if ((req.method === "GET" || req.method === "HEAD") && serveStatic(req, res, p)) return;

    if (req.method === "GET" && p === "/robots.txt") return sendText(res, 200, "User-agent: *\nDisallow: /api/\n");
    if (req.method === "GET" && p === "/.well-known/security.txt" && cfg.securityContact) {
      const exp = new Date(Date.now() + 180 * 864e5).toISOString();
      return sendText(res, 200, `Contact: ${cfg.securityContact}\nExpires: ${exp}\nPreferred-Languages: id, en\n`);
    }
    if (req.method === "GET" && p === "/healthz") {
      try { await db.query("SELECT 1"); return send(res, 200, { ok: true }); }
      catch (e) { log("error", "health_db_failed", { reqId, err: e.message }); return send(res, 503, { ok: false }); }
    }

    if (req.method === "POST" && p === "/api/rfq") {
      checkOrigin(req);
      limiter.hit("rfq:" + ip, L.rfqPerIp, L.rfqWindowMs);
      limiter.hit("rfq:global", L.rfqGlobalPerHour, 60 * 60e3); // rem darurat bila ada banjir kiriman
      const v = validateRfq(await readJson(req));
      const out = await createRfq(db, v);
      log("info", out.replay ? "rfq_replayed" : "rfq_created", { reqId, ticket: out.ticket, items: v.items.length, regency: v.regency });
      return send(res, out.replay ? 200 : 201, { ticket: out.ticket, created_at: out.created_at, wa: cfg.waNumber, privacy_version: PRIVACY_VERSION });
    }

    if (p === "/api/rfq" || p === "/healthz") throw new HttpError(405, "method_not_allowed", "Metode tidak didukung.");
    throw new HttpError(404, "not_found", "Halaman tidak ditemukan.");
  }

  const server = http.createServer(async (req, res) => {
    const reqId = crypto.randomBytes(6).toString("hex");
    const t0 = process.hrtime.bigint();
    const ip = clientIp(req);
    res.on("finish", () => {
      if (req.url === "/healthz") return;
      log(res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info", "http", {
        reqId, method: req.method, path: String(req.url).split("?")[0].slice(0, 200), status: res.statusCode,
        ms: Number((process.hrtime.bigint() - t0) / 1000000n), ip: ipTag(ip),
      });
    });
    try {
      await handle(req, res, reqId, ip);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof HttpError) {
        const extra = e.retryAfter ? { "Retry-After": String(e.retryAfter) } : {};
        if (e.status === 429) log("warn", "rate_limited", { reqId, path: String(req.url).split("?")[0], ip: ipTag(ip) });
        return send(res, e.status, { error: { code: e.code, message: e.message, fields: e.fields, reqId } }, extra);
      }
      // Detail error hanya ke log server, tidak pernah ke pengguna.
      log("error", "unhandled", { reqId, err: e.message, code: e.code, stack: e.stack });
      send(res, 500, { error: { code: "internal", message: "Terjadi kesalahan di server. Coba lagi, atau hubungi kami lewat WhatsApp.", reqId } });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  server.on("close", () => limiter.stop());
  return server;
}

/* ---------------- start ---------------- */
async function main() {
  const { cfg, problems } = config.load();
  if (problems.length) {
    for (const p of problems) log("fatal", "config_invalid", { problem: p });
    process.exit(1);
  }
  const db = await dbm.connect(cfg, log);
  const pending = await dbm.pendingMigrations(db);
  if (pending.length) {
    if (!cfg.autoMigrate) {
      log("fatal", "schema_outdated", { pending, fix: "jalankan `npm run migrate` dengan DATABASE_ADMIN_URL" });
      process.exit(1);
    }
    await dbm.migrate(db, log);
  }

  const runRetention = () => anonymizeExpired(db, cfg.retentionMonths)
    .then(n => n && log("info", "retention_anonymized", { rows: n, months: cfg.retentionMonths }))
    .catch(e => log("error", "retention_failed", { err: e.message }));
  setTimeout(runRetention, 60e3).unref();
  setInterval(runRetention, 24 * 3600e3).unref();

  const server = createApp({ cfg, db });
  server.on("error", e => {
    const hint = e.code === "EADDRINUSE" ? `port ${cfg.port} sudah dipakai proses lain (mungkin server versi lama masih jalan). Hentikan dengan Ctrl+C di terminalnya, atau ganti PORT di .env.` : undefined;
    log("fatal", "listen_failed", { err: e.message, hint });
    db.close().finally(() => process.exit(1));
  });
  server.listen(cfg.port, cfg.host, () => log("info", "listening", {
    url: `http://${cfg.host}:${cfg.port}`, db: db.kind, page: path.basename(PAGE_FILE), env: cfg.production ? "production" : "development",
  }));
  const stop = sig => { log("info", "shutdown", { sig }); server.close(() => db.close().finally(() => process.exit(0))); setTimeout(() => process.exit(1), 10e3).unref(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

process.on("unhandledRejection", e => { log("fatal", "unhandled_rejection", { err: String(e && e.message || e) }); process.exit(1); });

if (require.main === module) {
  main().catch(e => { log("fatal", "startup_failed", { err: e.message }); process.exit(1); });
}

module.exports = { createApp, securityHeaders, resolveStatic };
