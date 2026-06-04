"use strict";

// ─────────────────────────────────────────────────────
//  Baileys Pair API  — 515 reconnect fixed
//  GET /pp/pair?number=91XXXXXXXXXX&url=https://...
// ─────────────────────────────────────────────────────

const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  DisconnectReason,
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

// number → session object
const activeSessions = new Map();

// ─────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cleanSession(number) {
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

// ─────────────────────────────────────────────────────
//  BUILD ONE SOCKET  (called per-attempt)
// ─────────────────────────────────────────────────────
async function buildSocket(number) {
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
  return { sock, saveCreds };
}

// ─────────────────────────────────────────────────────
//  CREATE PAIR SESSION
//  Returns pair code string, fires DP in background
// ─────────────────────────────────────────────────────
async function createPairSession(number, imageUrl) {
  // Kill any old session
  const old = activeSessions.get(number);
  if (old?.sock) { try { old.sock.end(); } catch (_) {} }
  activeSessions.delete(number);
  cleanSession(number);

  // Shared state across sockets for this request
  const shared = {
    codeSent   : false,
    connected  : false,
    finished   : false,
    imageUrl,
    number,
  };
  activeSessions.set(number, shared);

  // Promise resolves with pair code once we get it
  return new Promise((resolve, reject) => {
    const globalTimeout = setTimeout(() => {
      if (!shared.connected) {
        shared.finished = true;
        activeSessions.delete(number);
        cleanSession(number);
        reject(new Error("Timeout: pair code nahi mila 30s me"));
      }
    }, 30_000);

    // ── recursive socket spawner ────────────────────────
    async function spawnSocket() {
      if (shared.finished) return;

      let saveCreds;
      try {
        const built = await buildSocket(number);
        shared.sock = built.sock;
        saveCreds   = built.saveCreds;
      } catch (e) {
        clearTimeout(globalTimeout);
        shared.finished = true;
        activeSessions.delete(number);
        cleanSession(number);
        return reject(e);
      }

      const sock = shared.sock;
      let pairRequested = false;

      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", async update => {
        const { connection, lastDisconnect } = update;
        const errCode = lastDisconnect?.error?.output?.statusCode;

        console.log(`[${number}] ${connection ?? "?"} | code: ${errCode ?? "-"}`);

        // ── CONNECTING → request pair code ─────────────
        if (connection === "connecting" && !pairRequested) {
          pairRequested = true;
          await sleep(3500);
          if (shared.connected || shared.finished) return;

          try {
            const raw  = await sock.requestPairingCode(number);
            const code = raw.match(/.{1,4}/g).join("-");
            console.log(`[${number}] pair code: ${code}`);

            if (!shared.codeSent) {
              shared.codeSent = true;
              clearTimeout(globalTimeout);
              resolve(code);   // ← API response goes here
            }
          } catch (e) {
            console.error(`[${number}] requestPairingCode error: ${e.message}`);
            pairRequested = false; // allow retry on next connecting
          }
        }

        // ── OPEN → run DP flow ──────────────────────────
        if (connection === "open") {
          if (shared.connected || shared.finished) return;
          shared.connected = true;
          clearTimeout(globalTimeout);
          await saveCreds();
          console.log(`[${number}] OPEN — starting DP flow`);
          runPostConnect(shared, sock, saveCreds);
        }

        // ── CLOSE ───────────────────────────────────────
        if (connection === "close") {
          if (shared.finished) return;

          // 515 = WA wants a fresh socket (normal after pair code request)
          if (errCode === 515) {
            console.log(`[${number}] 515 → spawning new socket`);
            await sleep(1500);
            spawnSocket();
            return;
          }

          // Already connected — post-connect handles it
          if (shared.connected) return;

          // Auth errors — fatal
          if (errCode === 401 || errCode === 403) {
            shared.finished = true;
            clearTimeout(globalTimeout);
            activeSessions.delete(number);
            cleanSession(number);
            if (!shared.codeSent) reject(new Error(`WA auth error (${errCode}). Linked Devices check karo.`));
            return;
          }

          // Other close before open — retry once
          console.log(`[${number}] close ${errCode} → retry socket`);
          await sleep(2000);
          spawnSocket();
        }
      });
    }

    spawnSocket();
  });
}

// ─────────────────────────────────────────────────────
//  POST-CONNECT: set DP after linking
// ─────────────────────────────────────────────────────
async function runPostConnect(shared, sock, saveCreds) {
  const { number, imageUrl } = shared;
  const self = jidNormalizedUser(sock.user.id);

  await sleep(3000); // let WA settle after link

  const imgPath = path.join(TEMP_DIR, `${number}_dp.jpg`);

  // Download image
  try {
    await dlFile(imageUrl, imgPath);
    console.log(`[${number}] Image downloaded`);
  } catch (e) {
    console.error(`[${number}] Image download failed: ${e.message}`);
    return finishSession(shared, sock, imgPath);
  }

  // ── DP Method 1: raw IQ query (fastest) ────────────
  let dpDone = false;
  try {
    const image = await Jimp.read(imgPath);
    const buf   = await image.scaleToFit({ w: 720, h: 720 }).getBuffer("image/jpeg");

    await sock.query({
      tag   : "iq",
      attrs : { to: "@s.whatsapp.net", type: "set", xmlns: "w:profile:picture" },
      content: [{ tag: "picture", attrs: { type: "image" }, content: buf }],
    });
    console.log(`[${number}] ✅ DP set (Method 1)`);
    dpDone = true;
  } catch (e) {
    console.log(`[${number}] Method 1 failed: ${e.message}`);
  }

  // ── DP Method 2: updateProfilePicture ──────────────
  if (!dpDone) {
    try {
      await sock.updateProfilePicture(self, fs.readFileSync(imgPath));
      console.log(`[${number}] ✅ DP set (Method 2)`);
      dpDone = true;
    } catch (e) {
      console.log(`[${number}] Method 2 failed: ${e.message}`);
    }
  }

  if (!dpDone) console.error(`[${number}] ❌ DP set FAILED`);

  await sleep(2000);
  finishSession(shared, sock, imgPath);
}

function finishSession(shared, sock, imgPath) {
  shared.finished = true;
  activeSessions.delete(shared.number);
  try { sock.logout(); } catch (_) { try { sock.end(); } catch (_) {} }
  cleanSession(shared.number);
  try { if (imgPath && fs.existsSync(imgPath)) fs.unlinkSync(imgPath); } catch (_) {}
  console.log(`[${shared.number}] Done & cleaned.`);
}

// ─────────────────────────────────────────────────────
//  ROUTE
// ─────────────────────────────────────────────────────
app.get("/pp/pair", async (req, res) => {
  const { number, url } = req.query;

  if (!number || !url)
    return res.status(400).json({
      success : false,
      error   : "number aur url dono required hain",
      example : "/pp/pair?number=917XXXXXXXXX&url=https://example.com/photo.jpg",
    });

  const phone = String(number).replace(/\D/g, "");
  if (phone.length < 7 || phone.length > 15)
    return res.status(400).json({ success: false, error: "Invalid phone number" });

  const imageUrl = String(url);
  if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://"))
    return res.status(400).json({ success: false, error: "Invalid image URL" });

  try {
    console.log(`[API] +${phone} | ${imageUrl}`);
    const code = await createPairSession(phone, imageUrl);
    return res.json({
      success   : true,
      number    : `+${phone}`,
      pair_code : code,
      message   : "WA → Settings → Linked Devices → Link with phone number → code enter karo",
      dp_note   : "DP auto set hoga linking ke baad",
    });
  } catch (e) {
    console.error(`[API] Error +${phone}: ${e.message}`);
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/", (_, res) => res.json({
  status    : "✅ running",
  endpoint  : "/pp/pair?number=91XXXXXXXXXX&url=https://image.jpg",
  sessions  : activeSessions.size,
}));

// ─────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Pair API running on port ${PORT}`);
  console.log(`📡 http://localhost:${PORT}/pp/pair?number=91XXX&url=https://...\n`);
});

process.on("uncaughtException",  e => console.error("[uncaughtException]",  e?.message ?? e));
process.on("unhandledRejection", e => console.error("[unhandledRejection]", e?.message ?? e));
