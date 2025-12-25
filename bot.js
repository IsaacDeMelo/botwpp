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

/**
 * ===============================
 * 🔁 CONTROLE DE QR (Promise-based)
 * ===============================
 */
let qrWaiters = [];

function resolveQrWaiters(qr) {
  qrWaiters.forEach(r => r(qr));
  qrWaiters = [];
}

function waitForQr(timeout = 30000) {
  return new Promise((resolve, reject) => {
    if (qrCode) return resolve(qrCode);
    if (ready) return resolve(null);

    const resolver = (qr) => {
      clearTimeout(timer);
      resolve(qr);
    };

    const timer = setTimeout(() => {
      qrWaiters = qrWaiters.filter(r => r !== resolver);
      reject(new Error("Timeout ao gerar QR Code"));
    }, timeout);

    qrWaiters.push(resolver);
  });
}

/**
 * ===============================
 * ⏱ Delay humano (1–3s)
 * ===============================
 */
function randomDelay(min = 1000, max = 3000) {
  const ms = min + Math.floor(Math.random() * (max - min));
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * ===============================
 * 🖼️ Lê imagem para envio VISÍVEL
 * ===============================
 */
async function mediaFromFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  return { image: buffer };
}

/**
 * ===============================
 * 🚀 START BOT
 * ===============================
 */
async function startBot() {
  if (connecting) {
    await waitForQr(15000).catch(() => {});
    return sock;
  }

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
    generateHighQualityLinkPreview: false,
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
      console.log("✅ WhatsApp conectado");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;

      ready = false;
      sock = null;
      qrCode = null;
      connecting = false;

      // Se a sessão foi invalidada, apagar tudo
      if (code === DisconnectReason.loggedOut) {
        try {
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            console.log("🧹 Sessão inválida — apagada");
          }
        } catch (e) {
          console.error("Erro ao limpar sessão", e);
        }
      }

      // Sempre permitir novo start
      console.log("🔌 WhatsApp desconectado — pronto para novo QR");
    }

    //
  });

  return sock;
}

/**
 * ===============================
 * 🧠 HELPERS
 * ===============================
 */
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
  try {
    await sock?.logout();
  } catch {}

  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log("🧹 Sessão apagada");
    }
  } catch (err) {
    console.error("Erro ao apagar sessão", err);
  }

  sock = null;
  ready = false;
  qrCode = null;
  connecting = false;
}

/**
 * ===============================
 * 📦 EXPORTS
 * ===============================
 */
module.exports = {
  startBot,
  getClient,
  getStatus,
  isReady,
  waitForQr,
  disconnectBot,
  randomDelay,
  mediaFromFile
};
