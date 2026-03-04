import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from "@itsukichan/baileys";
import { Boom } from "@hapi/boom";
import fs from "fs";
import EventEmitter from "events";

const DEFAULT_AUTH_DIR = "./auth";
const GROUP_METADATA_TTL_MS = 5 * 60_000;
const DEFAULT_RECONNECT_DELAY_MS = 2_500;
const FRESH_SESSION_RECOVERY_COOLDOWN_MS = 5 * 60_000;
const MAX_RECONNECT_ATTEMPTS_BEFORE_RECOVERY = 6;

function mapDisconnectReason(code) {
  if (code === 405) {
    return {
      label: "session_invalid_405",
      shouldReconnect: false,
      sessionLikelyInvalid: true,
      networkLikelyIssue: false,
      needsQr: true
    };
  }

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

  if (code === DisconnectReason.forbidden) {
    return {
      label: "forbidden",
      shouldReconnect: false,
      sessionLikelyInvalid: true,
      networkLikelyIssue: false,
      needsQr: true
    };
  }

  if (code === DisconnectReason.unavailableService) {
    return {
      label: "service_unavailable",
      shouldReconnect: true,
      sessionLikelyInvalid: false,
      networkLikelyIssue: true,
      needsQr: false
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
    this._lastFreshRecoveryAt = 0;
    this._sessionSeq = 0;
    this._activeSessionSeq = 0;
    this._browserProfiles = [
      () => Browsers.ubuntu(this.browserName),
      () => Browsers.windows(this.browserName),
      () => Browsers.appropriate(this.browserName)
    ];
    this._browserProfileIndex = 0;
    this.connectionInfo = {
      hasStoredCreds: false,
      waVersion: null,
      waVersionIsLatest: null,
      lastUpdateAt: null,
      lastOpenAt: null,
      lastCloseAt: null,
      lastDisconnectCode: null,
      lastDisconnectLabel: null,
      lastDisconnectMessage: null,
      shouldReconnect: false,
      reconnectAttempts: 0,
      freshSessionRecoveries: 0,
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

  _logConnection(event, details = {}) {
    const now = new Date().toISOString();
    const extra = Object.entries(details)
      .map(([k, v]) => `${k}=${v === null || v === undefined ? "-" : String(v)}`)
      .join(" ");
    console.log(`[BAILEY ${now}] ${event}${extra ? ` | ${extra}` : ""}`);
  }

  _isSocketSessionActive(sessionSeq, sockRef) {
    if (!sessionSeq || !sockRef) return false;
    return this._activeSessionSeq === sessionSeq && this.sock === sockRef;
  }

  _invalidateSocketSession() {
    this._activeSessionSeq += 1;
  }

  _resolveBrowserTuple() {
    const profileFactory = this._browserProfiles[this._browserProfileIndex] || this._browserProfiles[0];
    try {
      return profileFactory();
    } catch {
      return Browsers.ubuntu(this.browserName);
    }
  }

  _rotateBrowserProfile() {
    this._browserProfileIndex = (this._browserProfileIndex + 1) % this._browserProfiles.length;
  }

  async _tryFreshSessionRecovery(triggerLabel) {
    const now = Date.now();
    const withinCooldown = now - this._lastFreshRecoveryAt < FRESH_SESSION_RECOVERY_COOLDOWN_MS;
    if (withinCooldown) {
      this._logConnection("recovery_skipped_cooldown", {
        trigger: triggerLabel
      });
      return false;
    }

    this._lastFreshRecoveryAt = now;
    this._logConnection("fresh_session_recovery_start", {
      trigger: triggerLabel
    });

    try {
      this.destroySession();
      this._setConnectionInfo({
        freshSessionRecoveries: (Number(this.connectionInfo.freshSessionRecoveries) || 0) + 1,
        lastDisconnectLabel: "session_recovery_triggered",
        shouldReconnect: false,
        reconnectAttempts: 0,
        needsQr: true,
        sessionLikelyInvalid: true,
        networkLikelyIssue: false
      });
      await this.start();
      this._logConnection("fresh_session_recovery_done", {
        trigger: triggerLabel
      });
      return true;
    } catch (error) {
      this._logConnection("fresh_session_recovery_failed", {
        trigger: triggerLabel,
        error: error?.message || "unknown"
      });
      return false;
    }
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

  async start(options = {}) {
    const force = Boolean(options?.force);
    const freshAuth = Boolean(options?.freshAuth);

    if (force && (this._starting || this.sock || this.status === "connecting" || this.status === "connected")) {
      await this.stop();
    }

    if (this.status === "connecting" || this.status === "connected") {
      return;
    }
    if (this._starting) {
      return;
    }

    this._starting = true;
    this.status = "connecting";
    this._clearReconnectTimer();

    if (freshAuth || (this.connectionInfo?.sessionLikelyInvalid && this._hasStoredCreds())) {
      this._logConnection("start_with_fresh_auth", {
        freshAuth
      });
      this.destroySession();
    }

    this._setConnectionInfo({
      hasStoredCreds: this._hasStoredCreds(),
      needsQr: false
    });

    try {
      if (!fs.existsSync(this.authDir)) {
        fs.mkdirSync(this.authDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version, isLatest } = await fetchLatestBaileysVersion({ timeout: 6000 });
      const waVersion = Array.isArray(version) ? version.join(".") : null;
      this._setConnectionInfo({
        waVersion,
        waVersionIsLatest: Boolean(isLatest)
      });
      this._logConnection("wa_version_selected", {
        waVersion: waVersion || "-",
        isLatest: Boolean(isLatest)
      });

      this.sock = makeWASocket({
        auth: state,
        browser: this._resolveBrowserTuple(),
        version,
        printQRInTerminal: false,
        syncFullHistory: this.syncFullHistory,
        markOnlineOnConnect: this.markOnlineOnConnect
      });
      const sessionSeq = ++this._sessionSeq;
      const sockRef = this.sock;
      this._activeSessionSeq = sessionSeq;

      this.sock.ev.on("connection.update", (update) => {
        if (!this._isSocketSessionActive(sessionSeq, sockRef)) {
          return;
        }
        const { connection, qr, lastDisconnect } = update;

        if (connection === "connecting") {
          this._logConnection("connection_connecting", {
            hasStoredCreds: this._hasStoredCreds()
          });
        }

        if (qr) {
          this.qrCode = qr;
          this._setConnectionInfo({
            needsQr: true,
            shouldReconnect: false,
            sessionLikelyInvalid: true,
            networkLikelyIssue: false
          });
          this._logConnection("qr_received", {
            qrLength: String(qr).length
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
          this._logConnection("connection_open", {
            status: this.status
          });
          this.emitter.emit("connected");
        }

        if (connection === "close") {
          const reason =
            lastDisconnect?.error instanceof Boom
              ? lastDisconnect.error.output.statusCode
              : null;
          const reasonMessage = String(
            lastDisconnect?.error?.message ||
            lastDisconnect?.error?.output?.payload?.message ||
            ""
          ).trim() || null;
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
            lastDisconnectMessage: reasonMessage,
            shouldReconnect,
            reconnectAttempts: shouldReconnect
              ? (Number(this.connectionInfo.reconnectAttempts) || 0) + 1
              : 0,
            sessionLikelyInvalid: Boolean(classified.sessionLikelyInvalid),
            networkLikelyIssue: Boolean(classified.networkLikelyIssue),
            needsQr: Boolean(classified.needsQr)
          });
          this._logConnection("connection_close", {
            code: reason,
            label: classified.label,
            shouldReconnect,
            reconnectAttempts: this.connectionInfo.reconnectAttempts,
            hasStoredCreds: this.connectionInfo.hasStoredCreds,
            message: reasonMessage || "-"
          });

          this.emitter.emit("disconnected", {
            reason,
            shouldReconnect,
            reasonLabel: classified.label,
            networkLikelyIssue: classified.networkLikelyIssue,
            sessionLikelyInvalid: classified.sessionLikelyInvalid
          });

          if (shouldReconnect) {
            if ((Number(this.connectionInfo.reconnectAttempts) || 0) >= MAX_RECONNECT_ATTEMPTS_BEFORE_RECOVERY) {
              void this._tryFreshSessionRecovery("too_many_reconnect_attempts");
              return;
            }
            this._scheduleReconnect();
            this._logConnection("reconnect_scheduled", {
              delayMs: this._reconnectDelayMs
            });
            return;
          }

          if (classified.sessionLikelyInvalid && this._hasStoredCreds()) {
            void this._tryFreshSessionRecovery(classified.label);
          }
        }
      });

      this.sock.ev.on("messages.upsert", async (event) => {
        if (!this._isSocketSessionActive(sessionSeq, sockRef)) {
          return;
        }
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
    const currentSock = this.sock;
    this._invalidateSocketSession();
    if (!currentSock) {
      this.sock = null;
      this.status = "closed";
      this.qrCode = null;
      return;
    }

    try {
      currentSock.end();
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
    await this.start({
      force: true
    });
  }

  async logout({ destroy = false } = {}) {
    this._starting = false;
    this._clearReconnectTimer();
    this._invalidateSocketSession();

    const currentSock = this.sock;
    if (currentSock) {
      try {
        await currentSock.logout();
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
    this._invalidateSocketSession();
    if (fs.existsSync(this.authDir)) {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    }
    this.sock = null;
    this.qrCode = null;
    this.status = "logged_out";
    this._setConnectionInfo({
      hasStoredCreds: false,
      needsQr: true,
      sessionLikelyInvalid: true,
      shouldReconnect: false
    });
  }

  async startFresh() {
    let lastSignal = null;

    for (let attempt = 0; attempt < this._browserProfiles.length; attempt += 1) {
      await this.start({
        force: true,
        freshAuth: true
      });

      const signal = await this.waitForAuthSignal(12_000);
      lastSignal = signal;

      const shouldTryNextBrowser =
        signal?.kind === "disconnected" &&
        Number(signal?.details?.reason) === 405;

      if (!shouldTryNextBrowser) {
        return signal;
      }

      this._logConnection("start_fresh_retry_next_browser", {
        attempt: attempt + 1,
        reason: signal?.details?.reason
      });
      this._rotateBrowserProfile();
    }

    return lastSignal || { kind: "timeout" };
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

  waitForAuthSignal(timeoutMs = 12_000) {
    if (this.status === "connected") {
      return Promise.resolve({
        kind: "connected"
      });
    }

    if (this.status === "connecting" && this.qrCode) {
      return Promise.resolve({
        kind: "qr",
        qr: this.qrCode
      });
    }

    return new Promise((resolve) => {
      let resolved = false;

      const done = (payload) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        this.off("qr", onQr);
        this.off("connected", onConnected);
        this.off("disconnected", onDisconnected);
        resolve(payload);
      };

      const onQr = (qr) => done({
        kind: "qr",
        qr
      });

      const onConnected = () => done({
        kind: "connected"
      });

      const onDisconnected = (details) => done({
        kind: "disconnected",
        details
      });

      const timer = setTimeout(() => done({
        kind: "timeout"
      }), Math.max(2_000, Number(timeoutMs) || 12_000));

      this.on("qr", onQr);
      this.on("connected", onConnected);
      this.on("disconnected", onDisconnected);
    });
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
