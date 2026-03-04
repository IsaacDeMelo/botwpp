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
const DEFAULT_RECONNECT_DELAY_MS = 2_500;

function mapDisconnectReason(code) {
  if (code === DisconnectReason.loggedOut) {
    return {
      label: "logged_out",
      shouldReconnect: false,
      sessionLikelyInvalid: true,
      networkLikelyIssue: false,
      needsQr: true
    };
  }

  if (code === DisconnectReason.badSession) {
    return {
      label: "bad_session",
      shouldReconnect: false,
      sessionLikelyInvalid: true,
      networkLikelyIssue: false,
      needsQr: true
    };
  }

  if (code === DisconnectReason.connectionReplaced) {
    return {
      label: "connection_replaced",
      shouldReconnect: false,
      sessionLikelyInvalid: true,
      networkLikelyIssue: false,
      needsQr: true
    };
  }

  if (code === DisconnectReason.connectionClosed) {
    return {
      label: "connection_closed",
      shouldReconnect: true,
      sessionLikelyInvalid: false,
      networkLikelyIssue: true,
      needsQr: false
    };
  }

  if (code === DisconnectReason.connectionLost) {
    return {
      label: "connection_lost",
      shouldReconnect: true,
      sessionLikelyInvalid: false,
      networkLikelyIssue: true,
      needsQr: false
    };
  }

  if (code === DisconnectReason.timedOut) {
    return {
      label: "timed_out",
      shouldReconnect: true,
      sessionLikelyInvalid: false,
      networkLikelyIssue: true,
      needsQr: false
    };
  }

  if (code === DisconnectReason.restartRequired) {
    return {
      label: "restart_required",
      shouldReconnect: true,
      sessionLikelyInvalid: false,
      networkLikelyIssue: false,
      needsQr: false
    };
  }

  if (code === DisconnectReason.multideviceMismatch) {
    return {
      label: "multidevice_mismatch",
      shouldReconnect: false,
      sessionLikelyInvalid: true,
      networkLikelyIssue: false,
      needsQr: true
    };
  }

  return {
    label: code ? `reason_${code}` : "unknown",
    shouldReconnect: true,
    sessionLikelyInvalid: false,
    networkLikelyIssue: true,
    needsQr: false
  };
}

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
    this._reconnectTimer = null;
    this._reconnectDelayMs = Number(options.reconnectDelayMs) || DEFAULT_RECONNECT_DELAY_MS;
    this.connectionInfo = {
      hasStoredCreds: false,
      lastUpdateAt: null,
      lastOpenAt: null,
      lastCloseAt: null,
      lastDisconnectCode: null,
      lastDisconnectLabel: null,
      shouldReconnect: false,
      reconnectAttempts: 0,
      sessionLikelyInvalid: false,
      networkLikelyIssue: false,
      needsQr: false
    };

    this.emitter = new EventEmitter();
    this.groupCache = new Map();
  }

  _setConnectionInfo(patch) {
    this.connectionInfo = {
      ...this.connectionInfo,
      ...patch,
      lastUpdateAt: new Date().toISOString()
    };
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      void this.start();
    }, this._reconnectDelayMs);
  }

  _clearReconnectTimer() {
    if (!this._reconnectTimer) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
  }

  _hasStoredCreds() {
    const credsPath = `${this.authDir}/creds.json`;
    return fs.existsSync(credsPath);
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
    this._clearReconnectTimer();
    this._setConnectionInfo({
      hasStoredCreds: this._hasStoredCreds(),
      needsQr: false
    });

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
          this._setConnectionInfo({
            needsQr: true,
            shouldReconnect: false,
            sessionLikelyInvalid: true,
            networkLikelyIssue: false
          });
          this.emitter.emit("qr", qr);
        }

        if (connection === "open") {
          this.status = "connected";
          this.qrCode = null;
          this._starting = false;
          this._setConnectionInfo({
            hasStoredCreds: true,
            lastOpenAt: new Date().toISOString(),
            lastDisconnectCode: null,
            lastDisconnectLabel: null,
            shouldReconnect: false,
            reconnectAttempts: 0,
            sessionLikelyInvalid: false,
            networkLikelyIssue: false,
            needsQr: false
          });
          this.emitter.emit("connected");
        }

        if (connection === "close") {
          const reason =
            lastDisconnect?.error instanceof Boom
              ? lastDisconnect.error.output.statusCode
              : null;
          const classified = mapDisconnectReason(reason);
          const shouldReconnect = Boolean(classified.shouldReconnect);

          this.status = shouldReconnect ? "reconnecting" : "logged_out";
          this.qrCode = null;
          this.sock = null;
          this._starting = false;
          this._setConnectionInfo({
            hasStoredCreds: this._hasStoredCreds(),
            lastCloseAt: new Date().toISOString(),
            lastDisconnectCode: reason,
            lastDisconnectLabel: classified.label,
            shouldReconnect,
            reconnectAttempts: shouldReconnect
              ? (Number(this.connectionInfo.reconnectAttempts) || 0) + 1
              : 0,
            sessionLikelyInvalid: Boolean(classified.sessionLikelyInvalid),
            networkLikelyIssue: Boolean(classified.networkLikelyIssue),
            needsQr: Boolean(classified.needsQr)
          });

          this.emitter.emit("disconnected", {
            reason,
            shouldReconnect,
            reasonLabel: classified.label,
            networkLikelyIssue: classified.networkLikelyIssue,
            sessionLikelyInvalid: classified.sessionLikelyInvalid
          });

          if (shouldReconnect) {
            this._scheduleReconnect();
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
      this._setConnectionInfo({
        hasStoredCreds: this._hasStoredCreds(),
        shouldReconnect: false,
        needsQr: false
      });
      throw err;
    }
  }

  async stop() {
    this._starting = false;
    this._clearReconnectTimer();
    if (!this.sock) return;

    try {
      this.sock.end();
    } catch {}

    this.sock = null;
    this.status = "closed";
    this.qrCode = null;
    this._setConnectionInfo({
      shouldReconnect: false,
      needsQr: false
    });
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  async logout({ destroy = false } = {}) {
    this._starting = false;
    this._clearReconnectTimer();

    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {}
    }

    this.sock = null;
    this.qrCode = null;
    this.status = "logged_out";
    this._setConnectionInfo({
      hasStoredCreds: this._hasStoredCreds(),
      shouldReconnect: false,
      reconnectAttempts: 0,
      sessionLikelyInvalid: true,
      networkLikelyIssue: false,
      needsQr: true,
      lastDisconnectLabel: "manual_logout"
    });

    if (destroy) {
      this.destroySession();
      this._setConnectionInfo({
        hasStoredCreds: false
      });
    }
  }

  destroySession() {
    this._clearReconnectTimer();
    if (fs.existsSync(this.authDir)) {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    }
    this._setConnectionInfo({
      hasStoredCreds: false,
      needsQr: true,
      sessionLikelyInvalid: true
    });
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

  getConnectionInfo() {
    return {
      status: this.status,
      hasQRCode: Boolean(this.qrCode),
      hasSocket: Boolean(this.sock),
      ...this.connectionInfo
    };
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
