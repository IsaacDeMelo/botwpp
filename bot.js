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

    logger: pino({
      level: "info",
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard"
        }
      }
    }),

    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    emitOwnEvents: false,
    generateHighQualityLinkPreview: false,
    shouldSyncHistoryMessage: () => false,
    getMessage: async () => undefined
  });

  sock.ev.on("creds.update", saveCreds);
  
  //
  sock.ev.on("connection.update", (update) => {
    console.log("🌐 CONNECTION UPDATE", update);

    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      console.log("📸 QR RECEBIDO");
      qrCode = qr;
      resolveQrWaiters(qr);
    }

    if (connection === "connecting") {
      console.log("⏳ Conectando ao WhatsApp...");
    }

    if (connection === "open") {
      ready = true;
      qrCode = null;
      connecting = false;
      console.log("✅ WHATSAPP AUTENTICADO E ONLINE");
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      const message = lastDisconnect?.error?.message;

      console.error("❌ CONEXÃO FECHADA", { reason, message });

      ready = false;
      sock = null;
      qrCode = null;
      connecting = false;

      if (reason === DisconnectReason.loggedOut) {
        console.warn("🚨 LOGOUT DETECTADO — LIMPANDO SESSÃO");
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch (e) {
          console.error("Erro ao limpar sessão", e);
        }
      }

      console.log("🔄 Pronto para novo QR");
    }
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
