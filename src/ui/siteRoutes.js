import crypto from "crypto";
import QRCode from "qrcode";
import { sendAny } from "../utils/sendAny.js";

const UI_SESSION_COOKIE = "ui_session";
const UI_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

const uiSessions = new Map();
const loginAttempts = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function getUiPasswordHash() {
  const rawHash = String(process.env.UI_PASSWORD_HASH || "").trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(rawHash)) {
    return rawHash;
  }

  const rawPassword = process.env.UI_PASSWORD;
  if (rawPassword) {
    return sha256Hex(rawPassword);
  }

  return null;
}

function safeCompareHash(a, b) {
  try {
    const left = Buffer.from(String(a), "hex");
    const right = Buffer.from(String(b), "hex");
    if (left.length !== right.length || left.length === 0) return false;
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function parseCookies(header = "") {
  const out = {};
  const parts = String(header).split(";");
  for (const raw of parts) {
    const item = raw.trim();
    if (!item) continue;
    const eqIndex = item.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = item.slice(0, eqIndex).trim();
    const value = item.slice(eqIndex + 1).trim();
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function getClientIp(req) {
  const xfwd = String(req.headers["x-forwarded-for"] || "");
  if (xfwd) {
    return xfwd.split(",")[0].trim();
  }
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

function sessionCookieValue(sessionId) {
  const secure = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const securePart = secure ? "; Secure" : "";
  return `${UI_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(UI_SESSION_TTL_MS / 1000)}${securePart}`;
}

function clearSessionCookieValue() {
  const secure = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const securePart = secure ? "; Secure" : "";
  return `${UI_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${securePart}`;
}

function pruneStores() {
  const now = Date.now();

  for (const [sessionId, session] of uiSessions.entries()) {
    if (!session || now - session.createdAtMs > UI_SESSION_TTL_MS) {
      uiSessions.delete(sessionId);
    }
  }

  for (const [ip, data] of loginAttempts.entries()) {
    if (!data) {
      loginAttempts.delete(ip);
      continue;
    }
    if (data.blockedUntilMs && data.blockedUntilMs > now) {
      continue;
    }
    if (now - (data.windowStartMs || 0) > LOGIN_WINDOW_MS) {
      loginAttempts.delete(ip);
    }
  }
}

function addUiHeaders(reply, contentType = "application/json; charset=utf-8") {
  reply.header("content-type", contentType);
  reply.header("cache-control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  reply.header("pragma", "no-cache");
  reply.header("expires", "0");
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  reply.header("cross-origin-opener-policy", "same-origin");
  reply.header("cross-origin-resource-policy", "same-origin");
  reply.header(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
}

function createSession(req) {
  const sessionId = crypto.randomBytes(32).toString("hex");
  const userAgent = String(req.headers["user-agent"] || "unknown");
  const ip = getClientIp(req);
  const createdAt = nowIso();

  const data = {
    sessionId,
    createdAt,
    createdAtMs: Date.now(),
    lastSeenAt: createdAt,
    ip,
    userAgent
  };

  uiSessions.set(sessionId, data);
  return data;
}

function getValidSession(req) {
  pruneStores();

  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[UI_SESSION_COOKIE];
  if (!sessionId) return null;

  const session = uiSessions.get(sessionId);
  if (!session) return null;

  if (Date.now() - session.createdAtMs > UI_SESSION_TTL_MS) {
    uiSessions.delete(sessionId);
    return null;
  }

  const currentIp = getClientIp(req);
  const currentAgent = String(req.headers["user-agent"] || "unknown");
  if (session.ip !== currentIp || session.userAgent !== currentAgent) {
    uiSessions.delete(sessionId);
    return null;
  }

  session.lastSeenAt = nowIso();
  return session;
}

async function requireUiSession(req, reply) {
  const session = getValidSession(req);
  if (!session) {
    addUiHeaders(reply);
    reply.code(401).send({
      error: "UI_UNAUTHORIZED"
    });
    return null;
  }

  req.uiSession = session;
  return session;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const data = loginAttempts.get(ip);

  if (!data || now - (data.windowStartMs || 0) > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, {
      windowStartMs: now,
      attempts: 1,
      blockedUntilMs: 0
    });
    return;
  }

  data.attempts += 1;
  if (data.attempts >= LOGIN_MAX_ATTEMPTS) {
    data.blockedUntilMs = now + LOGIN_BLOCK_MS;
    data.attempts = 0;
    data.windowStartMs = now;
  }
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

function loginStateForIp(ip) {
  const data = loginAttempts.get(ip);
  if (!data) return { blocked: false, retryAfterMs: 0 };
  const now = Date.now();
  if (data.blockedUntilMs && data.blockedUntilMs > now) {
    return { blocked: true, retryAfterMs: data.blockedUntilMs - now };
  }
  return { blocked: false, retryAfterMs: 0 };
}

function panelHtml() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ITSUKI Panel</title>
  <link rel="stylesheet" href="/ui/app.css">
</head>
<body>
  <main class="page">
    <section id="loginCard" class="card">
      <h1>Painel ITSUKI</h1>
      <p class="muted">Autentique com a senha local do painel.</p>
      <form id="loginForm">
        <label for="passwordInput">Senha</label>
        <input id="passwordInput" type="password" autocomplete="current-password" required>
        <button type="submit">Entrar</button>
      </form>
      <p id="loginError" class="error"></p>
    </section>

    <section id="appPanel" class="hidden">
      <header class="row card">
        <div>
          <h2>Conexao WhatsApp</h2>
          <p id="statusLine">status: -</p>
          <p id="statusMeta" class="muted"></p>
        </div>
        <div class="actions">
          <button data-action="start">Start</button>
          <button data-action="restart">Restart</button>
          <button data-action="logout">Logout</button>
          <button data-action="shutdown">Shutdown</button>
          <button id="logoutUiBtn" class="danger">Sair painel</button>
        </div>
      </header>

      <section class="grid">
        <article class="card">
          <h3>QR Code</h3>
          <p class="muted">Atualizacao automatica somente quando o status estiver em <code>connecting</code>.</p>
          <div id="qrWrap" class="qr-wrap">
            <p id="qrHint" class="muted">Sem QR ativo no momento.</p>
            <img id="qrImage" alt="QR Code WhatsApp">
          </div>
        </article>

        <article class="card">
          <h3>Envio JSON</h3>
          <p class="muted">Envia 1 payload por vez para <code>/ui/api/send</code>.</p>
          <form id="sendForm">
            <textarea id="sendBody" spellcheck="false">{
  "type": "text",
  "to": "5511999999999",
  "text": "Ola"
}</textarea>
            <button type="submit">Enviar</button>
          </form>
          <pre id="sendResult"></pre>
        </article>
      </section>
    </section>
  </main>
  <script src="/ui/app.js"></script>
</body>
</html>`;
}

function panelCss() {
  return `:root {
  --bg: #f5f4f0;
  --surface: #ffffff;
  --ink: #1a1f2b;
  --muted: #5e6470;
  --accent: #0f766e;
  --danger: #c62828;
  --line: #d8dde6;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
  background: radial-gradient(circle at top left, #fff8e7, var(--bg) 45%);
  color: var(--ink);
}
.page {
  max-width: 1100px;
  margin: 24px auto;
  padding: 0 16px 32px;
}
.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.05);
}
h1, h2, h3 {
  margin-top: 0;
}
label {
  display: block;
  font-weight: 600;
  margin-bottom: 8px;
}
input, textarea, button {
  width: 100%;
  border-radius: 10px;
  border: 1px solid var(--line);
  padding: 10px 12px;
  font: inherit;
}
textarea {
  min-height: 220px;
  resize: vertical;
  font-family: Consolas, "Courier New", monospace;
}
button {
  cursor: pointer;
  background: var(--accent);
  color: #fff;
  border: none;
  font-weight: 600;
}
button:hover {
  filter: brightness(1.06);
}
.danger {
  background: var(--danger);
}
.muted {
  color: var(--muted);
}
.error {
  color: var(--danger);
  min-height: 20px;
}
.hidden {
  display: none;
}
.row {
  display: flex;
  gap: 16px;
  justify-content: space-between;
  align-items: flex-start;
}
.actions {
  display: grid;
  gap: 8px;
  min-width: 200px;
}
.grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  margin-top: 16px;
}
.qr-wrap {
  border: 1px dashed var(--line);
  border-radius: 12px;
  min-height: 370px;
  display: grid;
  place-items: center;
  overflow: hidden;
  padding: 10px;
}
#qrImage {
  width: min(360px, 100%);
  display: none;
}
pre {
  margin: 12px 0 0;
  background: #10151f;
  color: #d7e0f0;
  border-radius: 10px;
  padding: 12px;
  overflow: auto;
  min-height: 80px;
}
@media (max-width: 800px) {
  .row {
    flex-direction: column;
  }
  .actions {
    width: 100%;
    min-width: 0;
  }
}`;
}

function panelJs() {
  return `const loginCard = document.getElementById("loginCard");
const appPanel = document.getElementById("appPanel");
const loginForm = document.getElementById("loginForm");
const passwordInput = document.getElementById("passwordInput");
const loginError = document.getElementById("loginError");
const statusLine = document.getElementById("statusLine");
const statusMeta = document.getElementById("statusMeta");
const qrImage = document.getElementById("qrImage");
const qrHint = document.getElementById("qrHint");
const sendForm = document.getElementById("sendForm");
const sendBody = document.getElementById("sendBody");
const sendResult = document.getElementById("sendResult");
const logoutUiBtn = document.getElementById("logoutUiBtn");
const actionButtons = Array.from(document.querySelectorAll("[data-action]"));

let statusTimer = null;
let qrTimer = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "content-type": "application/json"
    },
    ...options
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = data?.error || "REQUEST_FAILED";
    throw new Error(error);
  }
  return data;
}

function showLogin() {
  appPanel.classList.add("hidden");
  loginCard.classList.remove("hidden");
}

function showPanel() {
  loginCard.classList.add("hidden");
  appPanel.classList.remove("hidden");
}

function updateStatusView(payload) {
  const status = payload?.status || payload?.connection?.status || "-";
  const connection = payload?.connection || {};
  statusLine.textContent = "status: " + status;
  statusMeta.textContent =
    "ultima atualizacao: " + (connection.lastUpdateAt || "-") +
    " | reconnect: " + String(connection.reconnectAttempts || 0) +
    " | precisa QR: " + String(Boolean(connection.needsQr));

  const mustPollQr = status === "connecting";
  if (mustPollQr && !qrTimer) {
    pollQrNow();
    qrTimer = setInterval(pollQrNow, 2200);
  }
  if (!mustPollQr && qrTimer) {
    clearInterval(qrTimer);
    qrTimer = null;
    qrImage.style.display = "none";
    qrHint.style.display = "block";
    qrHint.textContent = "Sem QR ativo no momento.";
  }
}

async function pollStatusNow() {
  try {
    const data = await api("/ui/api/status");
    updateStatusView(data);
  } catch (err) {
    if (String(err.message) === "UI_UNAUTHORIZED") {
      stopTimers();
      showLogin();
      return;
    }
    statusMeta.textContent = "falha ao consultar status";
  }
}

async function pollQrNow() {
  try {
    const data = await api("/ui/api/qr");
    if (data?.available && data?.dataUrl) {
      qrImage.src = data.dataUrl;
      qrImage.style.display = "block";
      qrHint.style.display = "none";
      return;
    }
    qrImage.style.display = "none";
    qrHint.style.display = "block";
    qrHint.textContent = "Aguardando QR...";
  } catch {
    qrImage.style.display = "none";
    qrHint.style.display = "block";
    qrHint.textContent = "Falha ao atualizar QR.";
  }
}

function stopTimers() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  if (qrTimer) {
    clearInterval(qrTimer);
    qrTimer = null;
  }
}

function startTimers() {
  stopTimers();
  pollStatusNow();
  statusTimer = setInterval(pollStatusNow, 2500);
}

async function runAuthProbe() {
  try {
    await api("/ui/api/me");
    showPanel();
    startTimers();
  } catch {
    showLogin();
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";

  try {
    await api("/ui/login", {
      method: "POST",
      body: JSON.stringify({
        password: passwordInput.value
      })
    });
    passwordInput.value = "";
    showPanel();
    startTimers();
  } catch (err) {
    loginError.textContent = String(err.message) === "UI_AUTH_BLOCKED"
      ? "Muitas tentativas. Aguarde e tente novamente."
      : "Senha invalida.";
  }
});

actionButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const action = button.getAttribute("data-action");
    if (!action) return;
    try {
      await api("/ui/api/bailey/" + action, { method: "POST", body: "{}" });
      await pollStatusNow();
    } catch (err) {
      statusMeta.textContent = "acao falhou: " + String(err.message);
    }
  });
});

logoutUiBtn.addEventListener("click", async () => {
  try {
    await api("/ui/logout", { method: "POST", body: "{}" });
  } catch {}
  stopTimers();
  showLogin();
});

sendForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const body = JSON.parse(sendBody.value);
    const data = await api("/ui/api/send", {
      method: "POST",
      body: JSON.stringify(body)
    });
    sendResult.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    sendResult.textContent = JSON.stringify({
      error: String(err.message)
    }, null, 2);
  }
});

runAuthProbe();`;
}

function buildExamples() {
  return [
    {
      name: "Texto simples",
      method: "POST",
      endpoint: "/ui/api/send",
      body: {
        type: "text",
        to: "5511999999999",
        text: "Ola"
      }
    },
    {
      name: "Interactive buttons",
      method: "POST",
      endpoint: "/ui/api/send",
      body: {
        type: "interactive",
        to: "5511999999999",
        content: {
          text: "Escolha uma opcao",
          footer: "ITSUKI",
          buttons: [
            { buttonId: "op_1", buttonText: { displayText: "Opcao 1" }, type: 1 },
            { buttonId: "op_2", buttonText: { displayText: "Opcao 2" }, type: 1 }
          ]
        }
      }
    },
    {
      name: "Midia imagem URL",
      method: "POST",
      endpoint: "/ui/api/send",
      body: {
        type: "media",
        to: "5511999999999",
        mediaType: "image",
        media: {
          url: "https://picsum.photos/400/300"
        },
        caption: "Exemplo"
      }
    }
  ];
}

export function registerUiRoutes(app, { bailey, taskService }) {
  app.get("/", async (req, reply) => {
    addUiHeaders(reply, "text/html; charset=utf-8");
    return reply.send(panelHtml());
  });

  app.get("/ui/app.css", async (req, reply) => {
    addUiHeaders(reply, "text/css; charset=utf-8");
    return reply.send(panelCss());
  });

  app.get("/ui/app.js", async (req, reply) => {
    addUiHeaders(reply, "application/javascript; charset=utf-8");
    return reply.send(panelJs());
  });

  app.post("/ui/login", async (req, reply) => {
    addUiHeaders(reply);

    const hash = getUiPasswordHash();
    if (!hash) {
      return reply.code(503).send({
        error: "UI_PASSWORD_NOT_CONFIGURED"
      });
    }

    const ip = getClientIp(req);
    const state = loginStateForIp(ip);
    if (state.blocked) {
      return reply.code(429).send({
        error: "UI_AUTH_BLOCKED",
        retryAfterMs: state.retryAfterMs
      });
    }

    const password = String(req.body?.password || "");
    const givenHash = sha256Hex(password);
    const valid = safeCompareHash(hash, givenHash);

    if (!valid) {
      recordLoginFailure(ip);
      return reply.code(401).send({
        error: "UI_AUTH_INVALID"
      });
    }

    clearLoginAttempts(ip);
    const session = createSession(req);
    reply.header("set-cookie", sessionCookieValue(session.sessionId));
    return reply.send({
      status: "ok",
      session: {
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt
      }
    });
  });

  app.post("/ui/logout", async (req, reply) => {
    addUiHeaders(reply);
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[UI_SESSION_COOKIE];
    if (sid) {
      uiSessions.delete(sid);
    }
    reply.header("set-cookie", clearSessionCookieValue());
    return reply.send({
      status: "ok"
    });
  });

  app.register(async function uiApi(uiApp) {
    uiApp.addHook("preHandler", async (req, reply) => {
      addUiHeaders(reply);
      const session = await requireUiSession(req, reply);
      if (!session) return reply;
      return undefined;
    });

    uiApp.get("/me", async (req) => ({
      authenticated: true,
      session: {
        createdAt: req.uiSession.createdAt,
        lastSeenAt: req.uiSession.lastSeenAt
      }
    }));

    uiApp.get("/status", async () => ({
      status: bailey.getStatus(),
      connection: bailey.getConnectionInfo()
    }));

    uiApp.get("/qr", async () => {
      const qr = bailey.getQRCode();
      if (!qr) {
        return {
          available: false
        };
      }

      const dataUrl = await QRCode.toDataURL(qr, {
        width: 360,
        margin: 2
      });
      return {
        available: true,
        dataUrl
      };
    });

    uiApp.get("/examples", async () => ({
      total: 3,
      items: buildExamples()
    }));

    uiApp.get("/tasks", async (req) => {
      const { status, to } = req.query || {};
      const limit = Math.min(Math.max(Number(req.query?.limit) || 30, 1), 200);
      const items = taskService.list({ status, to }).slice(0, limit);
      return {
        total: items.length,
        items
      };
    });

    uiApp.post("/bailey/start", async () => {
      const status = bailey.getStatus();
      const info = bailey.getConnectionInfo();
      const shouldFresh = status === "logged_out" || Boolean(info?.sessionLikelyInvalid);
      const authSignal = shouldFresh
        ? await bailey.startFresh()
        : (await bailey.start(), await bailey.waitForAuthSignal(12_000));

      return {
        status: bailey.getStatus(),
        authSignal,
        connection: bailey.getConnectionInfo()
      };
    });

    uiApp.post("/bailey/restart", async () => {
      await bailey.restart();
      const authSignal = await bailey.waitForAuthSignal(12_000);
      return {
        status: bailey.getStatus(),
        authSignal,
        connection: bailey.getConnectionInfo()
      };
    });

    uiApp.post("/bailey/logout", async () => {
      await bailey.logout({ destroy: true });
      const authSignal = await bailey.startFresh();
      return {
        status: bailey.getStatus(),
        authSignal,
        connection: bailey.getConnectionInfo()
      };
    });

    uiApp.post("/bailey/shutdown", async () => {
      await bailey.stop();
      return {
        status: "stopped"
      };
    });

    uiApp.post("/send", async (req, reply) => {
      await app.baileyGuard(req, reply);
      if (reply.sent) return;

      const result = await sendAny(bailey, req.body);
      const task = taskService.createFromSend({
        requestBody: req.body,
        sendResult: result
      });

      return {
        ...result,
        ...(task
          ? {
              awaitResponse: {
                taskId: task.id,
                status: task.status,
                expiresAt: task.expiresAt
              }
            }
          : {})
      };
    });

    uiApp.post("/tasks/permanent", async (req, reply) => {
      try {
        const { to, expected, action, notes } = req.body || {};
        if (!to) {
          return reply.code(400).send({ error: "TO_REQUIRED" });
        }

        const expectedList = Array.isArray(expected)
          ? expected
          : [
              {
                key: "",
                aliases: [String(req.body?.trigger || "").trim()],
                action
              }
            ];

        const created = taskService.createPersistentCommand({
          to,
          expected: expectedList,
          action,
          notes
        });

        return {
          status: "created",
          task: created
        };
      } catch (error) {
        return reply.code(400).send({
          error: error.message
        });
      }
    });
  }, { prefix: "/ui/api" });
}
