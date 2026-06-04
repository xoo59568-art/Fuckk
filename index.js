"use strict";

// ─────────────────────────────────────────────────────
//  Baileys Pair API
//  GET /pp/pair?number=91XXXXXXXXXX&url=https://...
//
//  Flow:
//  1. Socket-1 → connecting → requestPairingCode → return to API
//  2. Socket-1 → close(515) → Socket-2 spawn (same session dir, NO delete)
//  3. Socket-2 → open → DP set → logout → cleanup
// ─────────────────────────────────────────────────────

const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} = require("@whiskeysockets/baileys");
const { Jimp } = require("jimp");
const pino  = require("pino");
const path  = require("path");
const fs    = require("fs");
const https = require("https");
const http  = require("http");

const app          = express();
const PORT         = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(__dirname, "sessions");
const TEMP_DIR     = path.join(__dirname, "temp");

[SESSIONS_DIR, TEMP_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const activeSessions = new Map(); // number → shared

// ─────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function wipeDir(number) {
  try {
    const d = path.join(SESSIONS_DIR, number);
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  } catch (_) {}
}

function dlFile(url, dest) {
  return new Promise((res, rej) => {
    const proto = url.startsWith("https") ? https : http;
    const f = fs.createWriteStream(dest);
    proto.get(url, r => {
      if (r.statusCode === 301 || r.statusCode === 302)
        return dlFile(r.headers.location, dest).then(res).catch(rej);
      r.pipe(f);
      f.on("finish", () => { f.close(); res(); });
    }).on("error", e => { try { fs.unlinkSync(dest); } catch (_) {} rej(e); });
  });
}

async function getVersion() {
  try {
    const v = await fetchLatestBaileysVersion();
    if (v?.version) return v.version;
  } catch (_) {}
  return [2, 3000, 1021022925];
}

// ─────────────────────────────────────────────────────
//  SPAWN ONE SOCKET
//  Key rule: NEVER delete session dir between spawns
//  515 close → spawnSocket() again with same dir
// ─────────────────────────────────────────────────────
async function spawnSocket(shared) {
  if (shared.finished) return;

  const { number } = shared;
  const dir    = path.join(SESSIONS_DIR, number);
  fs.mkdirSync(dir, { recursive: true });   // create if first time, noop otherwise

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const logger  = pino({ level: "silent" });
  const version = await getVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds : state.creds,
      keys  : makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser             : ["Ubuntu", "Chrome", "121.0.6167.160"],
    printQRInTerminal   : false,
    syncFullHistory     : false,
    markOnlineOnConnect : false,
    connectTimeoutMs    : 60_000,
    keepAliveIntervalMs : 25_000,
    retryRequestDelayMs : 2_000,
  });

  shared.sock = sock;
  sock.ev.on("creds.update", saveCreds);

  let pairDone = false; // per-socket guard

  sock.ev.on("connection.update", async update => {
    const { connection, lastDisconnect } = update;
    const code = lastDisconnect?.error?.output?.statusCode;

    console.log(`[${number}] ${connection ?? "?"} | errCode=${code ?? "-"}`);

    // ── connecting ─────────────────────────────────────
    if (connection === "connecting" && !pairDone && !shared.codeSent) {
      pairDone = true;
      await sleep(3000);
      if (shared.connected || shared.finished) return;

      try {
        const raw  = await sock.requestPairingCode(number);
        const fmt  = raw.match(/.{1,4}/g).join("-");
        console.log(`[${number}] pair code: ${fmt}`);
        shared.codeSent = true;
        shared.resolvePair?.(fmt);   // resolve API promise
      } catch (e) {
        console.error(`[${number}] pairingCode error: ${e.message}`);
        pairDone = false;
      }
    }

    // ── open ───────────────────────────────────────────
    if (connection === "open") {
      if (shared.connected || shared.finished) return;
      shared.connected = true;
      await saveCreds();
      console.log(`[${number}] ✅ OPEN — device linked!`);
      runPostConnect(shared, sock).catch(e =>
        console.error(`[${number}] postConnect error: ${e.message}`)
      );
    }

    // ── close ──────────────────────────────────────────
    if (connection === "close") {
      if (shared.finished) return;
      if (shared.connected) return; // postConnect is running

      if (code === 515) {
        // Normal WA restart after pairing — keep session dir, spawn fresh socket
        console.log(`[${number}] 515 → respawn socket (session dir kept)`);
        await sleep(1500);
        spawnSocket(shared);
        return;
      }

      if (code === 401 || code === 403) {
        console.log(`[${number}] Auth fail ${code} → abort`);
        shared.finished = true;
        activeSessions.delete(number);
        wipeDir(number);
        shared.rejectPair?.(new Error(`WA auth error (${code})`));
        return;
      }

      // Other errors before open → retry
      console.log(`[${number}] close ${code} → retry in 2s`);
      await sleep(2000);
      spawnSocket(shared);
    }
  });
}

// ─────────────────────────────────────────────────────
//  POST CONNECT  — DP set
// ─────────────────────────────────────────────────────
async function runPostConnect(shared, sock) {
  const { number, imageUrl } = shared;

  await sleep(4000); // let WA fully settle

  const imgPath = path.join(TEMP_DIR, `${number}_dp.jpg`);

  // Download image
  try {
    await dlFile(imageUrl, imgPath);
    console.log(`[${number}] 📥 Image downloaded`);
  } catch (e) {
    console.error(`[${number}] Image dl failed: ${e.message}`);
    return doFinish(shared, sock, imgPath);
  }

  // ── DP Method 1: raw IQ (works on most versions) ───
  let dpOk = false;
  try {
    const img = await Jimp.read(imgPath);
    const buf = await img.scaleToFit({ w: 720, h: 720 }).getBuffer("image/jpeg");
    await sock.query({
      tag   : "iq",
      attrs : { to: "@s.whatsapp.net", type: "set", xmlns: "w:profile:picture" },
      content: [{ tag: "picture", attrs: { type: "image" }, content: buf }],
    });
    console.log(`[${number}] ✅ DP set (IQ query)`);
    dpOk = true;
  } catch (e) {
    console.log(`[${number}] Method 1 fail: ${e.message}`);
  }

  // ── DP Method 2: updateProfilePicture ──────────────
  if (!dpOk) {
    try {
      const self = jidNormalizedUser(sock.user.id);
      await sock.updateProfilePicture(self, fs.readFileSync(imgPath));
      console.log(`[${number}] ✅ DP set (updateProfilePicture)`);
      dpOk = true;
    } catch (e) {
      console.log(`[${number}] Method 2 fail: ${e.message}`);
    }
  }

  if (!dpOk) console.error(`[${number}] ❌ DP FAILED both methods`);

  await sleep(2000);
  await doFinish(shared, sock, imgPath);
}

// ─────────────────────────────────────────────────────
//  FINISH — logout + cleanup
// ─────────────────────────────────────────────────────
async function doFinish(shared, sock, imgPath) {
  const { number } = shared;
  shared.finished = true;
  activeSessions.delete(number);

  // Logout (give WA 5s to ACK)
  console.log(`[${number}] 🔌 Logging out...`);
  try {
    await Promise.race([sock.logout(), sleep(5000)]);
    console.log(`[${number}] ✅ Logout done`);
  } catch (e) {
    console.log(`[${number}] Logout err: ${e.message} — force end`);
    try { sock.end(); } catch (_) {}
  }

  // Wipe session dir
  wipeDir(number);
  console.log(`[${number}] 🗑️  Session dir wiped`);

  // Delete temp image
  try {
    if (imgPath && fs.existsSync(imgPath)) {
      fs.unlinkSync(imgPath);
      console.log(`[${number}] 🗑️  Temp image deleted`);
    }
  } catch (_) {}

  console.log(`[${number}] ✅ All done & clean.`);
}

// ─────────────────────────────────────────────────────
//  createPairSession  — entry point
// ─────────────────────────────────────────────────────
async function createPairSession(number, imageUrl) {
  // Kill any old session for this number
  const old = activeSessions.get(number);
  if (old) {
    old.finished = true;
    try { old.sock?.end(); } catch (_) {}
    activeSessions.delete(number);
    wipeDir(number);
    await sleep(500);
  }

  const shared = {
    number,
    imageUrl,
    sock        : null,
    codeSent    : false,
    connected   : false,
    finished    : false,
    resolvePair : null,
    rejectPair  : null,
  };
  activeSessions.set(number, shared);

  return new Promise((resolve, reject) => {
    // 30s global timeout
    const timer = setTimeout(() => {
      if (!shared.connected) {
        shared.finished = true;
        activeSessions.delete(number);
        wipeDir(number);
        reject(new Error("Timeout: 30s me pair code nahi mila"));
      }
    }, 30_000);

    shared.resolvePair = code => { clearTimeout(timer); resolve(code); };
    shared.rejectPair  = err  => { clearTimeout(timer); reject(err);   };

    spawnSocket(shared);
  });
}

// ─────────────────────────────────────────────────────
//  EXPRESS ROUTES
// ─────────────────────────────────────────────────────
app.get("/pp/pair", async (req, res) => {
  const { number, url } = req.query;

  if (!number || !url)
    return res.status(400).json({
      success : false,
      error   : "number aur url required",
      example : "/pp/pair?number=917XXXXXXXXX&url=https://img.example.com/photo.jpg",
    });

  const phone = String(number).replace(/\D/g, "");
  if (phone.length < 7 || phone.length > 15)
    return res.status(400).json({ success: false, error: "Invalid number format" });

  const imageUrl = String(url);
  if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://"))
    return res.status(400).json({ success: false, error: "Invalid image URL" });

  try {
    console.log(`\n[API] Request: +${phone} | ${imageUrl}`);
    const code = await createPairSession(phone, imageUrl);
    return res.json({
      success   : true,
      number    : `+${phone}`,
      pair_code : code,
      steps     : "WA → Settings → Linked Devices → Link with phone number → enter code",
      dp_note   : "DP automatically set hoga device link hone ke baad",
    });
  } catch (e) {
    console.error(`[API] Error +${phone}: ${e.message}`);
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/", (_, res) => res.json({
  status   : "✅ running",
  usage    : "/pp/pair?number=91XXXXXXXXXX&url=https://image.jpg",
  active   : activeSessions.size,
}));

// ─────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Pair API on port ${PORT}`);
  console.log(`📡 http://localhost:${PORT}/pp/pair?number=91XXX&url=https://img\n`);
});

process.on("uncaughtException",  e => console.error("[uncaughtException]",  e?.message ?? e));
process.on("unhandledRejection", e => console.error("[unhandledRejection]", e?.message ?? e));
