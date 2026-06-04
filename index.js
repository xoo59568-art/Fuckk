"use strict";

// ─────────────────────────────────────────────────────
//  Baileys Pair API
//  GET /pp/pair?number=91XXXXXXXXXX&url=https://...
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

// Active sessions: number → { sock, connected, finished }
const activeSessions = new Map();

// ─────────────────────────────────────────────────────
//  HELPER: download file from URL
// ─────────────────────────────────────────────────────
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cleanSession(number) {
  try {
    const d = path.join(SESSIONS_DIR, number);
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  } catch (_) {}
}

// ─────────────────────────────────────────────────────
//  MAIN: create pairing socket & return code
// ─────────────────────────────────────────────────────
async function createPairSession(number, imageUrl) {
  // Kill any existing session for this number
  const existing = activeSessions.get(number);
  if (existing?.sock) {
    try { existing.sock.end(); } catch (_) {}
  }
  activeSessions.delete(number);
  cleanSession(number);

  const dir = path.join(SESSIONS_DIR, number);
  fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const logger = pino({ level: "silent" });

  let version = [2, 3000, 1021022925];
  try {
    const v = await fetchLatestBaileysVersion();
    if (v?.version) version = v.version;
  } catch (_) {}

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds : state.creds,
      keys  : makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser             : ["Windows", "Chrome", "121.0.6167.160"],
    printQRInTerminal   : false,
    syncFullHistory     : false,
    markOnlineOnConnect : false,
    connectTimeoutMs    : 60_000,
    keepAliveIntervalMs : 25_000,
  });

  sock.ev.on("creds.update", saveCreds);

  const session = {
    sock,
    connected : false,
    finished  : false,
    imageUrl,
    number,
  };
  activeSessions.set(number, session);

  // Wait for "connecting" then request pair code
  const pairCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for pair code")), 30_000);
    let requested = false;

    sock.ev.on("connection.update", async update => {
      const { connection, lastDisconnect } = update;
      const errCode = lastDisconnect?.error?.output?.statusCode;

      if (connection === "connecting" && !requested) {
        requested = true;
        await sleep(3000);
        try {
          const raw  = await sock.requestPairingCode(number);
          const code = raw.match(/.{1,4}/g).join("-");
          clearTimeout(timeout);
          resolve(code);
        } catch (e) {
          clearTimeout(timeout);
          reject(e);
        }
      }

      if (connection === "open") {
        session.connected = true;
        await saveCreds();
        console.log(`[${number}] Connected! Running post-connect...`);
        runPostConnect(session).catch(e => console.error(`[${number}] post-connect error:`, e.message));
      }

      if (connection === "close") {
        if (session.connected || session.finished) return;
        if (errCode === 515) {
          // WA restart request — reconnect silently
          console.log(`[${number}] 515 restart`);
          return;
        }
        console.log(`[${number}] closed before open: ${errCode}`);
        activeSessions.delete(number);
        cleanSession(number);
      }
    });
  });

  return pairCode;
}

// ─────────────────────────────────────────────────────
//  POST-CONNECT: set DP after device linked
// ─────────────────────────────────────────────────────
async function runPostConnect(session) {
  const { sock, number, imageUrl } = session;
  const self = jidNormalizedUser(sock.user.id);

  console.log(`[${number}] Setting DP from: ${imageUrl}`);

  await sleep(3000); // let WA settle

  // Download image
  const imgPath = path.join(TEMP_DIR, `${number}_dp.jpg`);
  try {
    await dlFile(imageUrl, imgPath);
  } catch (e) {
    console.error(`[${number}] Image download failed:`, e.message);
    return finish(session, imgPath);
  }

  // Set DP — Method 1: Jimp + raw IQ query
  let dpDone = false;
  try {
    const image = await Jimp.read(imgPath);
    const buf   = await image.scaleToFit({ w: 720, h: 720 }).getBuffer("image/jpeg");

    await sock.query({
      tag   : "iq",
      attrs : { to: "@s.whatsapp.net", type: "set", xmlns: "w:profile:picture" },
      content: [{ tag: "picture", attrs: { type: "image" }, content: buf }],
    });
    console.log(`[${number}] DP set via Method 1`);
    dpDone = true;
  } catch (e) {
    console.log(`[${number}] Method 1 failed: ${e.message}`);
  }

  // Method 2: updateProfilePicture
  if (!dpDone) {
    try {
      await sock.updateProfilePicture(self, fs.readFileSync(imgPath));
      console.log(`[${number}] DP set via Method 2`);
      dpDone = true;
    } catch (e) {
      console.log(`[${number}] Method 2 failed: ${e.message}`);
    }
  }

  if (!dpDone) {
    console.error(`[${number}] DP set FAILED — both methods exhausted`);
  }

  await sleep(2000);
  finish(session, imgPath);
}

function finish(session, imgPath) {
  const { sock, number } = session;
  session.finished = true;
  try { sock.logout(); } catch (_) { try { sock.end(); } catch (_) {} }
  activeSessions.delete(number);
  cleanSession(number);
  try { if (imgPath && fs.existsSync(imgPath)) fs.unlinkSync(imgPath); } catch (_) {}
  console.log(`[${number}] Session cleaned.`);
}

// ─────────────────────────────────────────────────────
//  ROUTE: GET /pp/pair?number=91XXX&url=https://...
// ─────────────────────────────────────────────────────
app.get("/pp/pair", async (req, res) => {
  const { number, url } = req.query;

  // ── Validation ──────────────────────────────────────
  if (!number || !url) {
    return res.status(400).json({
      success : false,
      error   : "number aur url dono required hain",
      example : "/pp/pair?number=917XXXXXXXXX&url=https://example.com/photo.jpg",
    });
  }

  const phone = String(number).replace(/\D/g, "");
  if (phone.length < 7 || phone.length > 15) {
    return res.status(400).json({
      success : false,
      error   : "Invalid phone number",
      example : "917288837763",
    });
  }

  let imageUrl = String(url);
  if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) {
    return res.status(400).json({ success: false, error: "Invalid image URL" });
  }

  // ── Create session & get pair code ──────────────────
  try {
    console.log(`[API] Pair request: +${phone} | url: ${imageUrl}`);
    const code = await createPairSession(phone, imageUrl);
    return res.json({
      success    : true,
      number     : `+${phone}`,
      pair_code  : code,
      message    : "WA → Settings → Linked Devices → Link with phone number",
      dp_status  : "DP will be set automatically after linking",
    });
  } catch (e) {
    console.error(`[API] Error for ${phone}:`, e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ── Health check ──────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status   : "running",
    endpoint : "/pp/pair?number=91XXXXXXXXXX&url=https://image-url.jpg",
    sessions : activeSessions.size,
  });
});

// ─────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Pair API running on port ${PORT}`);
  console.log(`📡 Endpoint: http://localhost:${PORT}/pp/pair?number=91XXX&url=https://...`);
});

process.on("uncaughtException",  e => console.error("[uncaughtException]",  e?.message));
process.on("unhandledRejection", e => console.error("[unhandledRejection]", e?.message));
