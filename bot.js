// bot.js
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

const AUTH_DIR = path.resolve("./auth_data");

let sock = null;
let qrCode = null;
let ready = false;
let connecting = false;

/**
 * Delay humano (1–3s)
 */
function randomDelay() {
  const ms = 1000 + Math.floor(Math.random() * 2000);
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Limpa arquivos antigos da auth_data
 * Mantém apenas creds.json e arquivos recentes
 */
function cleanOldAuthFiles(maxAgeHours = 24) {
  if (!fs.existsSync(AUTH_DIR)) return;

  const now = Date.now();
  const maxAge = maxAgeHours * 60 * 60 * 1000;

  fs.readdirSync(AUTH_DIR).forEach(file => {
    if (file === "creds.json") return;

    const filePath = path.join(AUTH_DIR, file);

    try {
      const stat = fs.statSync(filePath);
      const age = now - stat.mtimeMs;

      if (age > maxAge) {
        fs.unlinkSync(filePath);
      }
    } catch {}
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

    // Browser leve
    browser: ["Safari", "macOS", "1.0"],

    // Silêncio + performance
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    emitOwnEvents: false,
    generateHighQualityLinkPreview: false,
    shouldSyncHistoryMessage: () => false,
    getMessage: async () => undefined
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      qrCode = qr;
      console.clear();
      console.log("📱 Escaneie o QR Code:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      ready = true;
      qrCode = null;
      connecting = false;

      // 🔥 LIMPEZA AUTOMÁTICA APÓS CONECTAR
      cleanOldAuthFiles(24);

      console.log("✅ WhatsApp conectado!");
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
  return { state: ready ? "ready" : "pending", qr: qrCode };
}

async function disconnectBot() {
  try { await sock?.logout(); } catch {}
  sock = null;
  ready = false;
  qrCode = null;
}

async function mediaFromFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  return { image: buffer };
}

module.exports = {
  startBot,
  disconnectBot,
  getClient,
  getStatus,
  mediaFromFile,
  isReady,
  randomDelay
};
