import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from "@itsukichan/baileys";
import { Boom } from "@hapi/boom";
import fs from "fs";
import EventEmitter from "events";

const DEFAULT_AUTH_DIR = "./auth";
const GROUP_METADATA_TTL_MS = 5 * 60_000;

function formatTimestampBR(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} | ${hh}:${min}`;
}

function unwrapContent(messageContent) {
  let current = messageContent && typeof messageContent === "object"
    ? messageContent
    : {};

  const wrappers = [
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "documentWithCaptionMessage"
  ];

  let moved = true;
  while (moved) {
    moved = false;
    for (const key of wrappers) {
      const nested = current?.[key]?.message;
      if (nested && typeof nested === "object") {
        current = nested;
        moved = true;
        break;
      }
    }
  }

  return current;
}

function extractMessagePreview(message) {
  const content = unwrapContent(message?.message || {});

  const buttonText =
    content?.buttonsResponseMessage?.selectedDisplayText ||
    content?.templateButtonReplyMessage?.selectedDisplayText;
  if (buttonText) {
    return String(buttonText);
  }

  const listText =
    content?.listResponseMessage?.singleSelectReply?.title ||
    content?.listResponseMessage?.title;
  if (listText) {
    return String(listText);
  }

  const text =
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    "";

  if (text) {
    return String(text);
  }

  return "<midia/interacao sem texto>";
}

export class BaileyClient {
  constructor(options = {}) {
    this.authDir = options.authDir || DEFAULT_AUTH_DIR;
    this.browserName = options.browserName || "ITSUKI-BAILEYS";
    this.syncFullHistory = Boolean(options.syncFullHistory);
    this.markOnlineOnConnect =
      options.markOnlineOnConnect === undefined
        ? false
        : Boolean(options.markOnlineOnConnect);

    this.sock = null;
    this.qrCode = null;
    this.status = "idle";
    this._starting = false;

    this.emitter = new EventEmitter();
    this.groupCache = new Map();
  }

  async _getGroupSubject(groupJid) {
    if (!groupJid || !this.sock) return null;

    const cached = this.groupCache.get(groupJid);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.subject;
    }

    try {
      const metadata = await this.sock.groupMetadata(groupJid);
      const subject = metadata?.subject || null;
      this.groupCache.set(groupJid, {
        subject,
        expiresAt: Date.now() + GROUP_METADATA_TTL_MS
      });
      return subject;
    } catch {
      return null;
    }
  }

  async _logIncomingMessages(event) {
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    for (const message of messages) {
      if (!message || message?.key?.fromMe) continue;

      const remoteJid = message?.key?.remoteJid || "";
      const participant = message?.key?.participant || "";
      const pushName = message?.pushName || "sem-nome";
      const preview = extractMessagePreview(message);
      const when = formatTimestampBR(new Date());

      if (remoteJid.endsWith("@g.us")) {
        const groupName = await this._getGroupSubject(remoteJid);
        console.log(
          `${when} Mensagem no grupo [${remoteJid}]` +
          `${groupName ? ` (${groupName})` : ""} ` +
          `do usuario [${participant || pushName}]: ${preview}`
        );
      } else {
        console.log(`${when} Mensagem do usuario [${remoteJid}]: ${preview}`);
      }
    }
  }

  async start() {
    if (this.status === "connecting" || this.status === "connected") {
      return;
    }
    if (this._starting) {
      return;
    }

    this._starting = true;
    this.status = "connecting";

    try {
      if (!fs.existsSync(this.authDir)) {
        fs.mkdirSync(this.authDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

      this.sock = makeWASocket({
        auth: state,
        browser: Browsers.ubuntu(this.browserName),
        printQRInTerminal: false,
        syncFullHistory: this.syncFullHistory,
        markOnlineOnConnect: this.markOnlineOnConnect
      });

      this.sock.ev.on("connection.update", (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
          this.qrCode = qr;
          this.emitter.emit("qr", qr);
        }

        if (connection === "open") {
          this.status = "connected";
          this.qrCode = null;
          this._starting = false;
          this.emitter.emit("connected");
        }

        if (connection === "close") {
          const reason =
            lastDisconnect?.error instanceof Boom
              ? lastDisconnect.error.output.statusCode
              : null;

          const shouldReconnect = reason !== DisconnectReason.loggedOut;

          this.status = shouldReconnect ? "closed" : "logged_out";
          this.qrCode = null;
          this.sock = null;
          this._starting = false;

          this.emitter.emit("disconnected", {
            reason,
            shouldReconnect
          });

          if (shouldReconnect) {
            setTimeout(() => this.start(), 2000);
          }
        }
      });

      this.sock.ev.on("messages.upsert", async (event) => {
        try {
          await this._logIncomingMessages(event);
        } catch {
          // do not break processing
        }
        this.emitter.emit("messages.upsert", event);
      });

      this.sock.ev.on("creds.update", saveCreds);
    } catch (err) {
      this._starting = false;
      this.status = "closed";
      this.sock = null;
      throw err;
    }
  }

  async stop() {
    this._starting = false;
    if (!this.sock) return;

    try {
      this.sock.end();
    } catch {}

    this.sock = null;
    this.status = "closed";
    this.qrCode = null;
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  async logout({ destroy = false } = {}) {
    this._starting = false;

    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {}
    }

    this.sock = null;
    this.qrCode = null;
    this.status = "logged_out";

    if (destroy) {
      this.destroySession();
    }
  }

  destroySession() {
    if (fs.existsSync(this.authDir)) {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    }
  }

  getQRCode() {
    if (this.status !== "connecting") return null;
    return this.qrCode;
  }

  getStatus() {
    return this.status;
  }

  getSocket() {
    return this.sock;
  }

  on(eventName, handler) {
    this.emitter.on(eventName, handler);
  }

  off(eventName, handler) {
    this.emitter.off(eventName, handler);
  }
}

export function createBailey(options = {}) {
  return new BaileyClient(options);
}

