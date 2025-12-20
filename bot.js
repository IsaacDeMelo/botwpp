// bot.js
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const fs = require("fs");
const path = require("path");

const AUTH_DIR = path.resolve("./auth_data");

let sock = null;
let qrCode = null;
let ready = false;
let connecting = false;

// listeners aguardando QR
let qrWaiters = [];

function resolveQrWaiters(qr) {
  qrWaiters.forEach(r => r(qr));
  qrWaiters = [];
}

function waitForQr(timeout = 30000) {
  return new Promise((resolve, reject) => {
    if (qrCode) return resolve(qrCode);
    if (ready) return resolve(null);

    const timer = setTimeout(() => {
      qrWaiters = qrWaiters.filter(r => r !== resolver);
      reject(new Error("Timeout ao gerar QR Code"));
    }, timeout);

    const resolver = (qr) => {
      clearTimeout(timer);
      resolve(qr);
    };

    qrWaiters.push(resolver);
  });
}

async function startBot() {
  if (sock || connecting) return sock;
  connecting = true;

  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    browser: ["Safari", "macOS", "1.0"],
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    emitOwnEvents: false,
    shouldSyncHistoryMessage: () => false,
    getMessage: async () => undefined
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      qrCode = qr;
      resolveQrWaiters(qr);
    }

    if (connection === "open") {
      ready = true;
      qrCode = null;
      connecting = false;
    }

    if (connection === "close") {
      ready = false;
      sock = null;
      qrCode = null;
      connecting = false;

      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.restartRequired) {
        setTimeout(startBot, 2000);
      }
    }
  });

  return sock;
}

function isReady() {
  return ready;
}

function getClient() {
  if (!sock) throw new Error("Bot não iniciado");
  return sock;
}

function getStatus() {
  return {
    state: ready ? "ready" : connecting ? "connecting" : "idle",
    qr: qrCode
  };
}

async function disconnectBot() {
  try { await sock?.logout(); } catch {}
  sock = null;
  ready = false;
  qrCode = null;
}

module.exports = {
  startBot,
  getClient,
  getStatus,
  isReady,
  waitForQr,
  disconnectBot
};
