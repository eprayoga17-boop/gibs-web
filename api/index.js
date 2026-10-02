"use strict";
/* Entry Vercel: semua request diarahkan ke sini lewat rewrites di vercel.json,
   lalu diteruskan ke server yang sama dengan `npm start` (server.js). */
const config = require("../lib/config");
const dbm = require("../lib/db");
const { createApp } = require("../server");

const log = (level, msg, extra = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }) + "\n");

let ready;
function boot() {
  if (!ready) {
    ready = (async () => {
      const { cfg, problems } = config.load();
      if (problems.length) throw new Error("config_invalid: " + problems.join("; "));
      const db = await dbm.connect(cfg, log);
      return createApp({ cfg, db, log });
    })();
    // Gagal boot (env salah, DB down) jangan di-cache: request berikutnya mencoba lagi.
    ready.catch(() => { ready = undefined; });
  }
  return ready;
}

module.exports = async (req, res) => {
  let app;
  try {
    app = await boot();
  } catch (e) {
    // Detail hanya ke log Vercel, tidak ke pengunjung.
    log("fatal", "startup_failed", { err: e.message });
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify({ error: { code: "unavailable", message: "Server sedang tidak tersedia. Coba lagi sebentar." } }));
  }
  app.emit("request", req, res);
};
