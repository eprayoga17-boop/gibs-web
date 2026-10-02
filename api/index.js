"use strict";
const config = require("../lib/config");
const dbm = require("../lib/db");
const { createApp } = require("../server");

let ready;
function boot() {
  if (!ready) ready = (async () => {
    const { cfg, problems } = config.load();
    if (problems.length) throw new Error("config_invalid: " + problems.join("; "));
    const db = await dbm.connect(cfg, console.log);
    return createApp({ cfg, db });
  })();
  return ready;
}
module.exports = async (req, res) => {
  const app = await boot();
  app.emit("request", req, res);
};