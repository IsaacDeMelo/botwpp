import crypto from "crypto";
import QRCode from "qrcode";
import { sendAny } from "../utils/sendAny.js";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const LOCK_MS = 15 * 60 * 1000;

const loginState = new Map();
const sessions = new Map();

function getIp(req) {
  return String(req.headers["x-forwarded-for"] || req.ip || "unknown").split(",")[0].trim();
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function timingSafeHexEqual(a, b) {
  const aBuf = Buffer.from(String(a), "hex");
  const bBuf = Buffer.from(String(b), "hex");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function parseCookies(header) {
  const out = {};
  const text = String(header || "");
  if (!text) return out;

  for (const item of text.split(";")) {
    const idx = item.indexOf("=");
    if (idx < 0) continue;
    const key = item.slice(0, idx).trim();
    const value = item.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  }

  return out;
}

function signToken(raw, secret) {
  return crypto.createHmac("sha256", secret).update(raw).digest("base64url");
}

function createSession(ip, userAgent, secret) {
  const id = crypto.randomBytes(24).toString("base64url");
  const exp = Date.now() + SESSION_TTL_MS;
  const fingerprint = sha256(`${ip}|${userAgent}`);
  const payload = JSON.stringify({ id, exp, fingerprint });
  const raw = Buffer.from(payload, "utf-8").toString("base64url");
  const sig = signToken(raw, secret);

  sessions.set(id, { exp, fingerprint });
  return `${raw}.${sig}`;
}

function verifySession(req, secret) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.ui_session;
  if (!token) return false;

  const [raw, sig] = String(token).split(".");
  if (!raw || !sig) return false;

  const expectedSig = signToken(raw, secret);
  const okSig = timingSafeHexEqual(sha256(sig), sha256(expectedSig));
  if (!okSig) return false;

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
  } catch {
    return false;
  }

  const id = String(parsed?.id || "");
  const exp = Number(parsed?.exp || 0);
  const fingerprint = String(parsed?.fingerprint || "");
  if (!id || !exp || !fingerprint) return false;
  if (Date.now() > exp) return false;

  const stored = sessions.get(id);
  if (!stored) return false;
  if (stored.exp !== exp || stored.fingerprint !== fingerprint) return false;

  const ip = getIp(req);
  const userAgent = String(req.headers["user-agent"] || "");
  const expectedFp = sha256(`${ip}|${userAgent}`);
  if (!timingSafeHexEqual(sha256(expectedFp), sha256(fingerprint))) return false;

  return true;
}

function cleanupMaps() {
  const now = Date.now();
  for (const [ip, state] of loginState.entries()) {
    if (state.lockUntil && state.lockUntil > now) continue;
    if (state.updatedAt && now - state.updatedAt > LOCK_MS * 2) {
      loginState.delete(ip);
    }
  }

  for (const [id, session] of sessions.entries()) {
    if (!session?.exp || session.exp <= now) {
      sessions.delete(id);
    }
  }
}

setInterval(cleanupMaps, 60_000).unref();

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const state = loginState.get(ip) || {
    attempts: 0,
    firstAt: now,
    lockUntil: 0,
    updatedAt: now
  };

  if (state.lockUntil && state.lockUntil > now) {
    return {
      blocked: true,
      retryAfterMs: state.lockUntil - now
    };
  }

  if (now - state.firstAt > LOGIN_WINDOW_MS) {
    state.attempts = 0;
    state.firstAt = now;
  }

  state.updatedAt = now;
  loginState.set(ip, state);

  return { blocked: false };
}

function registerFailedAttempt(ip) {
  const now = Date.now();
  const state = loginState.get(ip) || {
    attempts: 0,
    firstAt: now,
    lockUntil: 0,
    updatedAt: now
  };

  if (now - state.firstAt > LOGIN_WINDOW_MS) {
    state.attempts = 0;
    state.firstAt = now;
  }

  state.attempts += 1;
  state.updatedAt = now;

  if (state.attempts >= LOGIN_MAX_ATTEMPTS) {
    state.lockUntil = now + LOCK_MS;
  }

  loginState.set(ip, state);
  return state;
}

function clearAttempts(ip) {
  loginState.delete(ip);
}

function uiPageHtml({ scriptNonce }) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MIDZAP Panel</title>
<style nonce="${scriptNonce}">
:root {
  --bg-a:#0a121f;
  --bg-b:#121a2b;
  --panel:#111827cc;
  --panel-strong:#0f172acc;
  --line:#27364f;
  --text:#dbe5f6;
  --muted:#94a3b8;
  --ok:#22c55e;
  --warn:#f59e0b;
  --err:#ef4444;
  --info:#38bdf8;
  --action:#2563eb;
  --action-2:#334155;
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;
  color:var(--text);
  font-family:Bahnschrift,"Segoe UI",Tahoma,sans-serif;
  background:
    radial-gradient(900px 500px at 0% -20%, #1d4ed855, transparent 60%),
    radial-gradient(900px 500px at 100% 120%, #0ea5e955, transparent 60%),
    linear-gradient(140deg,var(--bg-a),var(--bg-b));
}
.wrap{max-width:1120px;margin:24px auto;padding:0 16px}
.card{
  background:linear-gradient(160deg,var(--panel),var(--panel-strong));
  border:1px solid var(--line);
  border-radius:16px;
  padding:16px;
  box-shadow:0 12px 28px #02061766;
}
.grid{display:grid;gap:14px}
.main-grid{grid-template-columns:1.2fr .8fr}
h1,h2,h3{margin:0}
h1{font-size:28px;letter-spacing:.2px}
h2{font-size:18px;color:#e2e8f0}
.sub{margin-top:6px;color:var(--muted);font-size:13px}
.hidden{display:none}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
button,input,textarea,select{
  width:100%;
  border-radius:10px;
  border:1px solid #314158;
  background:#0b1321;
  color:var(--text);
  padding:10px 12px;
  font-size:14px;
}
button{cursor:pointer;border:none;background:var(--action);font-weight:700;transition:.18s ease}
button:hover{filter:brightness(1.08)}
button:disabled{opacity:.6;cursor:not-allowed}
button.ghost{background:var(--action-2)}
.toolbar{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
.pill{
  display:inline-flex;
  align-items:center;
  gap:8px;
  padding:6px 10px;
  border-radius:999px;
  border:1px solid #334155;
  background:#0b1321;
  font-size:12px;
}
.dot{width:8px;height:8px;border-radius:999px;background:var(--muted)}
.dot.ok{background:var(--ok)}
.dot.warn{background:var(--warn)}
.dot.err{background:var(--err)}
.kpi{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:10px}
.kpi .item{border:1px solid #2a3a53;background:#0b1321;border-radius:12px;padding:10px}
.kpi .n{font-size:22px;font-weight:800}
.kpi .l{font-size:12px;color:var(--muted)}
.state{min-height:20px;font-size:13px;color:var(--muted)}
.state.ok{color:var(--ok)}
.state.err{color:var(--err)}
.qr-box{
  min-height:360px;
  border:1px dashed #36506f;
  border-radius:14px;
  display:flex;
  align-items:center;
  justify-content:center;
  background:#08101b;
  overflow:hidden;
}
.qr-box img{max-width:330px;width:100%;height:auto}
.qr-placeholder{color:var(--muted);font-size:13px;text-align:center;padding:10px}
pre{margin:0;background:#08101b;border:1px solid #2d3f59;border-radius:12px;padding:12px;overflow:auto;max-height:290px;font-size:12px}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.builder-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.field{display:grid;gap:6px}
.field label{font-size:12px;color:var(--muted);font-weight:700;letter-spacing:.2px}
.btn-list{display:grid;gap:8px}
.btn-row{display:grid;grid-template-columns:1fr 1fr auto;gap:8px}
.btn-row button{padding:8px 10px}
textarea#builderOut{min-height:300px;font-family:Consolas,"Courier New",monospace;font-size:12px}
textarea#builderText{min-height:90px}
textarea#builderTimeoutText{min-height:72px}
.mini{font-size:12px;color:var(--muted)}
@media (max-width: 980px){
  .main-grid{grid-template-columns:1fr}
  .toolbar{grid-template-columns:1fr 1fr}
  .builder-grid{grid-template-columns:1fr}
  .row{grid-template-columns:1fr}
}
</style>
</head>
<body>
<div class="wrap grid" style="gap:14px">
  <div id="loginCard" class="card" style="max-width:460px;margin:0 auto;">
    <h1>MIDZAP Secure Panel</h1>
    <div class="sub">Acesso local por senha. Sessao protegida por cookie HttpOnly.</div>
    <div style="height:14px"></div>
    <input id="password" type="password" placeholder="Digite a senha do painel" autocomplete="current-password" />
    <div style="height:10px"></div>
    <button id="loginBtn">Entrar</button>
    <div style="height:8px"></div>
    <div id="loginMsg" class="state"></div>
  </div>

  <div id="app" class="hidden grid" style="gap:14px">
    <div class="card">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-end;flex-wrap:wrap">
        <div>
          <h1>MIDZAP Control Center</h1>
          <div class="sub">Operacao em tempo real: status, QR, tarefas e comandos do bot.</div>
        </div>
        <div class="pill"><span id="statusDot" class="dot"></span><span id="baileyStatus">-</span></div>
      </div>
      <div style="height:12px"></div>
      <div class="toolbar">
        <button data-action="start">Start</button>
        <button data-action="restart">Restart</button>
        <button data-action="logout">Logout+Start</button>
        <button data-action="shutdown" class="ghost">Shutdown</button>
        <button id="logoutBtn" class="ghost">Sair</button>
      </div>
      <div style="height:10px"></div>
      <div id="controlMsg" class="state">Pronto.</div>
      <div class="kpi">
        <div class="item"><div id="taskTotal" class="n">0</div><div class="l">Tasks total</div></div>
        <div class="item"><div id="pendingCount" class="n">0</div><div class="l">Pending</div></div>
        <div class="item"><div id="persistentCount" class="n">0</div><div class="l">Persistent</div></div>
      </div>
    </div>

    <div class="grid main-grid">
      <div class="card grid" style="gap:10px">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
          <h2>QR Code</h2>
          <div class="actions" style="max-width:320px;width:100%">
            <button id="qrRefreshBtn" class="ghost">Atualizar QR</button>
            <button id="toggleQrAutoBtn">Auto QR: ON</button>
          </div>
        </div>
        <div class="sub">Quando status estiver connecting, o QR atualiza automaticamente.</div>
        <div class="qr-box" id="qrBox">
          <div class="qr-placeholder">Aguardando status do bot...</div>
        </div>
      </div>

      <div class="card grid" style="gap:10px">
        <h2>Payload Examples</h2>
        <div class="sub">Cada item possui endpoint proprio. Execute 1 item por requisicao.</div>
        <pre id="examples">Carregando...</pre>
        <div class="actions">
          <button id="refreshBtn" class="ghost">Atualizar painel</button>
          <button id="copyExamplesBtn">Copiar exemplos</button>
        </div>
      </div>
    </div>

    <div class="card grid" style="gap:10px">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
        <h2>Task Monitor</h2>
        <div class="actions" style="max-width:320px;width:100%">
          <button id="refreshTasksBtn" class="ghost">Atualizar tasks</button>
          <button id="copyTasksBtn" class="ghost">Copiar monitor</button>
        </div>
      </div>
      <div class="sub">Acompanhe tasks ativas, expiradas e pendencias de timeout em tempo real.</div>
      <pre id="tasksPreview">Carregando...</pre>
    </div>

    <div class="card grid" style="gap:12px">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
        <div>
          <h2>Payload Builder</h2>
          <div class="sub">Crie JSON para /api/send e /api/tasks/permanent sem montar manualmente.</div>
        </div>
        <div class="pill"><span class="dot ok"></span><span id="builderEndpointLabel">endpoint: /ui/api/send</span></div>
      </div>

      <div class="builder-grid">
        <div class="grid" style="gap:10px">
          <div class="row">
            <div class="field">
              <label for="builderMode">Modo</label>
              <select id="builderMode">
                <option value="text">Texto simples</option>
                <option value="interactive">Menu com botoes + timeout</option>
                <option value="permanent">Comando permanente (/menu)</option>
              </select>
            </div>
            <div class="field">
              <label for="builderTo">Destino (to)</label>
              <input id="builderTo" placeholder="558296921589" value="558296921589" />
            </div>
          </div>

          <div class="field">
            <label for="builderText">Texto principal</label>
            <textarea id="builderText" placeholder="Mensagem principal">Menu principal. Escolha:</textarea>
          </div>

          <div class="row">
            <div class="field">
              <label for="builderFooter">Footer (menu)</label>
              <input id="builderFooter" placeholder="Atendimento" value="Atendimento" />
            </div>
            <div class="field">
              <label for="builderTrigger">Trigger permanente</label>
              <input id="builderTrigger" placeholder="/menu" value="/menu" />
            </div>
          </div>

          <div class="field">
            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap">
              <label>Botoes do menu</label>
              <button type="button" id="addBuilderButtonRow" class="ghost">+ Adicionar botao</button>
            </div>
            <div id="builderButtons" class="btn-list"></div>
            <div class="mini">IDs de botao viram expected.key automaticamente.</div>
          </div>

          <div class="row">
            <div class="field">
              <label for="builderTimeoutMs">Timeout (ms)</label>
              <input id="builderTimeoutMs" type="number" min="0" step="1000" value="30000" />
            </div>
            <div class="field">
              <label for="builderActionType">Acao por opcao</label>
              <select id="builderActionType">
                <option value="echo">Responder texto automatico</option>
                <option value="none">Nenhuma acao</option>
              </select>
            </div>
          </div>

          <div class="field">
            <label for="builderTimeoutText">Mensagem no timeout</label>
            <textarea id="builderTimeoutText" placeholder="Mensagem de timeout">Voce demorou para responder. Digite /menu para abrir novamente.</textarea>
          </div>

          <div class="actions">
            <button id="builderGenerateBtn" class="ghost">Gerar JSON</button>
            <button id="builderSendBtn">Enviar agora</button>
          </div>
        </div>

        <div class="grid" style="gap:10px">
          <div class="field">
            <label for="builderOut">JSON gerado</label>
            <textarea id="builderOut" spellcheck="false"></textarea>
          </div>
          <div class="actions">
            <button id="builderCopyBtn" class="ghost">Copiar JSON</button>
            <button id="builderClearBtn" class="ghost">Limpar</button>
          </div>
          <div id="builderMsg" class="state"></div>
        </div>
      </div>
    </div>
  </div>
</div>
<script nonce="${scriptNonce}">
(function(){
  const el = {
    loginCard: document.getElementById('loginCard'),
    app: document.getElementById('app'),
    password: document.getElementById('password'),
    loginBtn: document.getElementById('loginBtn'),
    loginMsg: document.getElementById('loginMsg'),
    controlMsg: document.getElementById('controlMsg'),
    statusDot: document.getElementById('statusDot'),
    baileyStatus: document.getElementById('baileyStatus'),
    taskTotal: document.getElementById('taskTotal'),
    pendingCount: document.getElementById('pendingCount'),
    persistentCount: document.getElementById('persistentCount'),
    qrBox: document.getElementById('qrBox'),
    qrRefreshBtn: document.getElementById('qrRefreshBtn'),
    toggleQrAutoBtn: document.getElementById('toggleQrAutoBtn'),
    examples: document.getElementById('examples'),
    refreshBtn: document.getElementById('refreshBtn'),
    logoutBtn: document.getElementById('logoutBtn'),
    copyExamplesBtn: document.getElementById('copyExamplesBtn'),
    refreshTasksBtn: document.getElementById('refreshTasksBtn'),
    copyTasksBtn: document.getElementById('copyTasksBtn'),
    tasksPreview: document.getElementById('tasksPreview'),
    builderMode: document.getElementById('builderMode'),
    builderTo: document.getElementById('builderTo'),
    builderText: document.getElementById('builderText'),
    builderFooter: document.getElementById('builderFooter'),
    builderTrigger: document.getElementById('builderTrigger'),
    builderButtons: document.getElementById('builderButtons'),
    addBuilderButtonRow: document.getElementById('addBuilderButtonRow'),
    builderTimeoutMs: document.getElementById('builderTimeoutMs'),
    builderActionType: document.getElementById('builderActionType'),
    builderTimeoutText: document.getElementById('builderTimeoutText'),
    builderGenerateBtn: document.getElementById('builderGenerateBtn'),
    builderSendBtn: document.getElementById('builderSendBtn'),
    builderCopyBtn: document.getElementById('builderCopyBtn'),
    builderClearBtn: document.getElementById('builderClearBtn'),
    builderOut: document.getElementById('builderOut'),
    builderMsg: document.getElementById('builderMsg'),
    builderEndpointLabel: document.getElementById('builderEndpointLabel')
  };

  const state = {
    statusTimer: null,
    qrTimer: null,
    qrAuto: true,
    busyAction: false,
    baileyStatus: 'unknown'
  };

  function setMsg(text, kind) {
    el.controlMsg.textContent = text || '';
    el.controlMsg.className = 'state' + (kind ? ' ' + kind : '');
  }

  function setLoginMsg(text, kind) {
    el.loginMsg.textContent = text || '';
    el.loginMsg.className = 'state' + (kind ? ' ' + kind : '');
  }

  function setBuilderMsg(text, kind) {
    el.builderMsg.textContent = text || '';
    el.builderMsg.className = 'state' + (kind ? ' ' + kind : '');
  }

  function endpointForMode(mode) {
    return mode === 'permanent' ? '/ui/api/tasks/permanent' : '/ui/api/send';
  }

  function addButtonRow(idValue, textValue) {
    const row = document.createElement('div');
    row.className = 'btn-row';

    const idInput = document.createElement('input');
    idInput.placeholder = 'buttonId (ex: menu_vendas)';
    idInput.value = idValue || '';

    const textInput = document.createElement('input');
    textInput.placeholder = 'Texto exibido';
    textInput.value = textValue || '';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'ghost';
    removeBtn.textContent = 'Remover';
    removeBtn.addEventListener('click', () => {
      row.remove();
      refreshBuilderOut();
    });

    row.appendChild(idInput);
    row.appendChild(textInput);
    row.appendChild(removeBtn);
    el.builderButtons.appendChild(row);
  }

  function readButtons() {
    const rows = Array.from(el.builderButtons.querySelectorAll('.btn-row'));
    return rows
      .map((row) => {
        const fields = row.querySelectorAll('input');
        return {
          id: String(fields[0]?.value || '').trim(),
          text: String(fields[1]?.value || '').trim()
        };
      })
      .filter((item) => item.id || item.text)
      .map((item, idx) => ({
        id: item.id || ('btn_' + (idx + 1)),
        text: item.text || ('Opcao ' + (idx + 1))
      }));
  }

  function parseIntOrNull(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.floor(n);
  }

  function buildPayload() {
    const mode = String(el.builderMode.value || 'text');
    const to = String(el.builderTo.value || '').trim();
    const text = String(el.builderText.value || '').trim();
    const footer = String(el.builderFooter.value || '').trim();
    const trigger = String(el.builderTrigger.value || '/menu').trim() || '/menu';
    const timeoutMs = parseIntOrNull(el.builderTimeoutMs.value);
    const timeoutText = String(el.builderTimeoutText.value || '').trim();
    const actionType = String(el.builderActionType.value || 'echo');
    const btns = readButtons();

    if (!to) {
      throw new Error('TO_REQUIRED');
    }

    if (mode === 'text') {
      return {
        endpoint: '/ui/api/send',
        payload: {
          type: 'text',
          to,
          text: text || 'Mensagem de teste'
        }
      };
    }

    if (mode === 'interactive') {
      if (!btns.length) {
        throw new Error('ADD_AT_LEAST_ONE_BUTTON');
      }

      const payload = {
        type: 'interactive',
        to,
        content: {
          text: text || 'Menu principal. Escolha:',
          footer: footer || 'Atendimento',
          buttons: btns.map((b) => ({
            buttonId: b.id,
            buttonText: { displayText: b.text }
          }))
        }
      };

      if (btns.length > 0) {
        const expected = btns.map((b) => {
          const item = {
            key: b.id,
            aliases: [b.text]
          };

          if (actionType === 'echo') {
            item.action = {
              mode: 'send',
              payload: {
                type: 'text',
                text: 'Opcao selecionada: ' + b.text
              }
            };
          }

          return item;
        });

        payload.awaitResponse = {
          timeoutMs: timeoutMs === null ? 30000 : timeoutMs,
          expected
        };

        if (timeoutText) {
          payload.awaitResponse.onTimeout = {
            action: {
              mode: 'send',
              payload: {
                type: 'text',
                to,
                text: timeoutText
              }
            }
          };
        }
      }

      return { endpoint: '/ui/api/send', payload };
    }

    return {
      endpoint: '/ui/api/tasks/permanent',
      payload: {
        to,
        trigger,
        action: {
          mode: 'send',
          payload: {
            type: 'interactive',
            to,
            content: {
              text: text || 'Menu principal',
              footer: footer || 'Atendimento',
              buttons: (btns.length ? btns : [{ id: 'm1', text: 'Opcao 1' }]).map((b) => ({
                buttonId: b.id,
                buttonText: { displayText: b.text }
              }))
            }
          }
        }
      }
    };
  }

  function refreshBuilderOut() {
    const mode = String(el.builderMode.value || 'text');
    el.builderEndpointLabel.textContent = 'endpoint: ' + endpointForMode(mode);
    try {
      const built = buildPayload();
      el.builderOut.value = JSON.stringify(built.payload, null, 2);
      setBuilderMsg('JSON atualizado para ' + built.endpoint + '.', 'ok');
    } catch (error) {
      setBuilderMsg(error.message || 'Falha ao gerar JSON.', 'err');
    }
  }

  function setBusy(disabled) {
    state.busyAction = Boolean(disabled);
    document.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.disabled = state.busyAction;
    });
  }

  async function call(url, opts) {
    const req = opts || {};
    const hasBody = typeof req.body !== 'undefined';
    const headers = {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(req.headers || {})
    };

    const res = await fetch(url, {
      credentials: 'include',
      ...req,
      headers
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      throw new Error((data && (data.message || data.error)) || ('HTTP_' + res.status));
    }

    return data;
  }

  function updateStatusStyle(status) {
    const s = String(status || 'unknown').toLowerCase();
    el.statusDot.className = 'dot';
    if (s === 'connected') el.statusDot.classList.add('ok');
    else if (s === 'connecting') el.statusDot.classList.add('warn');
    else el.statusDot.classList.add('err');
    el.baileyStatus.textContent = s;
  }

  function renderQr(dataUrl, fallbackText) {
    if (dataUrl) {
      el.qrBox.innerHTML = '<img alt="QR Code" src="' + dataUrl + '" />';
      return;
    }
    el.qrBox.innerHTML = '<div class="qr-placeholder">' + (fallbackText || 'QR indisponivel no momento.') + '</div>';
  }

  async function refreshStatus() {
    const st = await call('/ui/api/status');
    state.baileyStatus = String(st.baileyStatus || 'unknown');
    updateStatusStyle(state.baileyStatus);

    const stats = st.taskStats || {};
    const byStatus = stats.byStatus || {};
    el.taskTotal.textContent = String(stats.total || 0);
    el.pendingCount.textContent = String(byStatus.pending || 0);
    el.persistentCount.textContent = String(byStatus.persistent || 0);
  }

  async function refreshExamples() {
    const ex = await call('/ui/api/examples');
    el.examples.textContent = JSON.stringify(ex, null, 2);
  }

  async function refreshTasksPreview() {
    const pending = await call('/ui/api/tasks?status=pending&limit=12');
    const attending = await call('/ui/api/tasks?status=attending&limit=12');
    const persistent = await call('/ui/api/tasks?status=persistent&limit=12');
    const expired = await call('/ui/api/tasks?status=expired&limit=6');
    const cancelled = await call('/ui/api/tasks?status=cancelled&limit=6');
    const now = Date.now();

    const active = []
      .concat(Array.isArray(pending.items) ? pending.items : [])
      .concat(Array.isArray(attending.items) ? attending.items : []);

    let nearest = null;
    for (const item of active) {
      const expiresAtMs = Number(item?.expiresAtMs || 0);
      if (!expiresAtMs) continue;
      if (!nearest || expiresAtMs < nearest.expiresAtMs) {
        nearest = {
          id: item.id,
          to: item.to,
          expiresAtMs
        };
      }
    }

    const summary = {
      generatedAt: new Date().toISOString(),
      totals: {
        pending: Number(pending.total || 0),
        attending: Number(attending.total || 0),
        persistent: Number(persistent.total || 0),
        expired: Number(expired.total || 0),
        cancelled: Number(cancelled.total || 0)
      },
      timeout: nearest
        ? {
            nextTaskId: nearest.id,
            to: nearest.to,
            expiresAt: new Date(nearest.expiresAtMs).toISOString(),
            remainingMs: Math.max(0, nearest.expiresAtMs - now)
          }
        : {
            nextTaskId: null,
            remainingMs: null
          },
      sample: {
        pending: (pending.items || []).slice(0, 3).map((t) => ({
          id: t.id,
          to: t.to,
          status: t.status,
          expiresAt: t.expiresAt
        })),
        attending: (attending.items || []).slice(0, 3).map((t) => ({
          id: t.id,
          to: t.to,
          status: t.status,
          expiresAt: t.expiresAt
        })),
        expired: (expired.items || []).slice(0, 3).map((t) => ({
          id: t.id,
          to: t.to,
          expiredAt: t.expiredAt
        }))
      }
    };

    el.tasksPreview.textContent = JSON.stringify(summary, null, 2);
  }

  async function refreshQr(force) {
    if (!force && (!state.qrAuto || state.baileyStatus !== 'connecting')) {
      return;
    }
    try {
      const q = await call('/ui/api/qr');
      renderQr(q.dataUrl || '', 'QR nao disponivel.');
    } catch (err) {
      if (String(err.message).includes('QR_NOT_AVAILABLE')) {
        renderQr('', 'Sem QR no momento. Se necessario, clique Start ou Restart.');
      } else {
        renderQr('', 'Falha ao carregar QR: ' + err.message);
      }
    }
  }

  async function fullRefresh(forceQr) {
    await refreshStatus();
    await refreshExamples();
    await refreshTasksPreview();
    await refreshQr(Boolean(forceQr));
  }

  function startPolling() {
    if (state.statusTimer) clearInterval(state.statusTimer);
    if (state.qrTimer) clearInterval(state.qrTimer);

    state.statusTimer = setInterval(async () => {
      try {
        await refreshStatus();
        await refreshTasksPreview();
      } catch {}
    }, 4000);

    state.qrTimer = setInterval(async () => {
      try {
        await refreshQr(false);
      } catch {}
    }, 3000);
  }

  function stopPolling() {
    if (state.statusTimer) clearInterval(state.statusTimer);
    if (state.qrTimer) clearInterval(state.qrTimer);
    state.statusTimer = null;
    state.qrTimer = null;
  }

  async function checkSession() {
    try {
      await call('/ui/api/me');
      el.loginCard.classList.add('hidden');
      el.app.classList.remove('hidden');
      setMsg('Sessao ativa.', 'ok');
      await fullRefresh(true);
      startPolling();
    } catch {
      stopPolling();
      el.loginCard.classList.remove('hidden');
      el.app.classList.add('hidden');
      renderQr('', 'Acesso bloqueado. Faca login para carregar o QR.');
    }
  }

  el.loginBtn.addEventListener('click', async () => {
    setLoginMsg('');
    const password = el.password.value || '';
    if (!password) {
      setLoginMsg('Informe a senha.', 'err');
      return;
    }

    try {
      await call('/ui/login', { method: 'POST', body: JSON.stringify({ password }) });
      el.password.value = '';
      await checkSession();
    } catch (e) {
      setLoginMsg(e.message, 'err');
    }
  });

  el.password.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      el.loginBtn.click();
    }
  });

  document.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (state.busyAction) return;
      const action = btn.getAttribute('data-action');
      setBusy(true);
      setMsg('Executando: ' + action + ' ...');
      try {
        await call('/ui/api/bailey/' + action, { method: 'POST' });
        setMsg('Comando executado: ' + action, 'ok');
        await fullRefresh(true);
      } catch (e) {
        setMsg('Falha em ' + action + ': ' + e.message, 'err');
      } finally {
        setBusy(false);
      }
    });
  });

  el.refreshBtn.addEventListener('click', async () => {
    setMsg('Atualizando painel...');
    try {
      await fullRefresh(true);
      setMsg('Painel atualizado.', 'ok');
    } catch (e) {
      setMsg('Falha ao atualizar: ' + e.message, 'err');
    }
  });

  el.qrRefreshBtn.addEventListener('click', async () => {
    setMsg('Atualizando QR...');
    try {
      await refreshQr(true);
      setMsg('QR atualizado.', 'ok');
    } catch (e) {
      setMsg('Falha ao atualizar QR: ' + e.message, 'err');
    }
  });

  el.toggleQrAutoBtn.addEventListener('click', () => {
    state.qrAuto = !state.qrAuto;
    el.toggleQrAutoBtn.textContent = 'Auto QR: ' + (state.qrAuto ? 'ON' : 'OFF');
    setMsg('Auto QR ' + (state.qrAuto ? 'ativado' : 'desativado') + '.', 'ok');
  });

  el.copyExamplesBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el.examples.textContent || '');
      setMsg('Exemplos copiados.', 'ok');
    } catch {
      setMsg('Nao foi possivel copiar automaticamente.', 'err');
    }
  });

  el.refreshTasksBtn.addEventListener('click', async () => {
    try {
      await refreshTasksPreview();
      setMsg('Monitor de tasks atualizado.', 'ok');
    } catch (e) {
      setMsg('Falha ao atualizar monitor: ' + e.message, 'err');
    }
  });

  el.copyTasksBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el.tasksPreview.textContent || '');
      setMsg('Monitor de tasks copiado.', 'ok');
    } catch {
      setMsg('Falha ao copiar monitor.', 'err');
    }
  });

  el.builderMode.addEventListener('change', refreshBuilderOut);
  el.builderTo.addEventListener('input', refreshBuilderOut);
  el.builderText.addEventListener('input', refreshBuilderOut);
  el.builderFooter.addEventListener('input', refreshBuilderOut);
  el.builderTrigger.addEventListener('input', refreshBuilderOut);
  el.builderTimeoutMs.addEventListener('input', refreshBuilderOut);
  el.builderActionType.addEventListener('change', refreshBuilderOut);
  el.builderTimeoutText.addEventListener('input', refreshBuilderOut);
  el.builderButtons.addEventListener('input', refreshBuilderOut);

  el.addBuilderButtonRow.addEventListener('click', () => {
    addButtonRow('', 'Nova opcao');
    refreshBuilderOut();
  });

  el.builderGenerateBtn.addEventListener('click', refreshBuilderOut);

  el.builderCopyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el.builderOut.value || '');
      setBuilderMsg('JSON copiado.', 'ok');
    } catch {
      setBuilderMsg('Falha ao copiar JSON.', 'err');
    }
  });

  el.builderClearBtn.addEventListener('click', () => {
    el.builderOut.value = '';
    setBuilderMsg('Area de JSON limpa.', 'ok');
  });

  el.builderSendBtn.addEventListener('click', async () => {
    try {
      const built = buildPayload();
      el.builderOut.value = JSON.stringify(built.payload, null, 2);
      const result = await call(built.endpoint, {
        method: 'POST',
        body: JSON.stringify(built.payload)
      });

      const msgId = result && result.messageId ? String(result.messageId) : '-';
      const taskId = result && result.awaitResponse && result.awaitResponse.taskId
        ? String(result.awaitResponse.taskId)
        : (result && result.task && result.task.id ? String(result.task.id) : '-');
      setBuilderMsg('Enviado com sucesso. messageId=' + msgId + ' taskId=' + taskId, 'ok');
      setMsg('Payload enviado via painel.', 'ok');
      await refreshStatus();
    } catch (error) {
      setBuilderMsg('Falha ao enviar: ' + (error.message || 'erro desconhecido'), 'err');
    }
  });

  el.logoutBtn.addEventListener('click', async () => {
    try {
      await call('/ui/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    await checkSession();
  });

  addButtonRow('menu_vendas', 'Vendas');
  addButtonRow('menu_financeiro', 'Financeiro');
  refreshBuilderOut();
  checkSession();
})();
</script>
</body>
</html>`;
}

export function registerUiRoutes(app, { bailey, taskService }) {
  const uiPasswordHashFromEnv = String(process.env.UI_PASSWORD_HASH || "").trim().toLowerCase();
  const uiPasswordPlain = String(process.env.UI_PASSWORD || "");
  const isSha256Hex = (value) => /^[a-f0-9]{64}$/.test(String(value || ""));

  let uiPasswordHash = uiPasswordHashFromEnv;

  if (!isSha256Hex(uiPasswordHash) && uiPasswordPlain) {
    uiPasswordHash = sha256(uiPasswordPlain);
    app.log.warn("UI_PASSWORD_HASH missing or invalid. Falling back to UI_PASSWORD.");
  }

  if (!isSha256Hex(uiPasswordHash)) {
    throw new Error("UI_PASSWORD_HASH_NOT_SET_OR_INVALID");
  }

  const sessionSecret = crypto.randomBytes(32).toString("hex");

  app.get("/", async (req, reply) => {
    const scriptNonce = crypto.randomBytes(16).toString("base64");
    reply
      .header("content-type", "text/html; charset=utf-8")
      .header("x-frame-options", "DENY")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header("permissions-policy", "camera=(), microphone=(), geolocation=()")
      .header("content-security-policy", `default-src 'self'; script-src 'self' 'nonce-${scriptNonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'`)
      .send(uiPageHtml({ scriptNonce }));
  });

  app.post("/ui/login", async (req, reply) => {
    const ip = getIp(req);
    const rate = checkLoginRateLimit(ip);
    if (rate.blocked) {
      return reply.code(429).send({
        error: "TOO_MANY_ATTEMPTS",
        retryAfterMs: rate.retryAfterMs
      });
    }

    const password = String(req.body?.password || "");
    const incomingHash = sha256(password);
    const ok = timingSafeHexEqual(incomingHash, uiPasswordHash);

    if (!ok) {
      const state = registerFailedAttempt(ip);
      const remaining = Math.max(0, LOGIN_MAX_ATTEMPTS - state.attempts);
      return reply.code(401).send({
        error: "INVALID_PASSWORD",
        remaining
      });
    }

    clearAttempts(ip);
    const token = createSession(ip, String(req.headers["user-agent"] || ""), sessionSecret);

    reply
      .header("set-cookie", `ui_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`)
      .send({ status: "ok" });
  });

  app.post("/ui/logout", async (req, reply) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.ui_session;

    if (token) {
      const [raw] = String(token).split(".");
      if (raw) {
        try {
          const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
          if (parsed?.id) {
            sessions.delete(parsed.id);
          }
        } catch {
          // ignore
        }
      }
    }

    reply
      .header("set-cookie", "ui_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
      .send({ status: "ok" });
  });

  app.register(async function uiApi(uiApp) {
    uiApp.addHook("preHandler", async (req, reply) => {
      if (!verifySession(req, sessionSecret)) {
        return reply.code(401).send({ error: "UI_UNAUTHORIZED" });
      }
    });

    uiApp.get("/me", async () => ({ status: "ok" }));

    uiApp.get("/status", async () => ({
      baileyStatus: bailey.getStatus(),
      taskStats: taskService.stats()
    }));

    uiApp.get("/qr", async (req, reply) => {
      const qr = bailey.getQRCode();
      if (!qr) {
        return reply.code(404).send({ error: "QR_NOT_AVAILABLE" });
      }

      const dataUrl = await QRCode.toDataURL(qr, { width: 340, margin: 2 });
      return { dataUrl };
    });

    uiApp.get("/tasks", async (req) => {
      const { status, to, limit } = req.query || {};
      const max = Math.max(1, Math.min(200, Number(limit) || 50));
      const items = taskService.list({ status, to }).slice(0, max);
      return {
        total: items.length,
        items
      };
    });

    uiApp.post("/bailey/start", async () => {
      await bailey.start();
      return { status: "starting" };
    });

    uiApp.post("/bailey/restart", async () => {
      await bailey.restart();
      return { status: "restarting" };
    });

    uiApp.post("/bailey/logout", async () => {
      await bailey.logout();
      await bailey.start();
      return { status: "restarting_session" };
    });

    uiApp.post("/bailey/shutdown", async () => {
      await bailey.stop();
      return { status: "stopped" };
    });

    uiApp.post("/send", async (req, reply) => {
      try {
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
      } catch (error) {
        return reply.code(400).send({
          error: error?.message || "SEND_FAILED"
        });
      }
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
          error: error?.message || "PERSISTENT_CREATE_FAILED"
        });
      }
    });

    uiApp.get("/examples", async () => ({
      notice: "Envie 1 payload por requisicao. Nao envie o objeto inteiro de exemplos em /api/send.",
      items: [
        {
          name: "send_text",
          method: "POST",
          endpoint: "/api/send",
          body: {
            type: "text",
            to: "558296921589",
            text: "Teste rapido"
          }
        },
        {
          name: "send_menu_with_timeout",
          method: "POST",
          endpoint: "/api/send",
          body: {
            type: "interactive",
            to: "558296921589",
            content: {
              text: "Menu principal. Escolha:",
              footer: "Atendimento",
              buttons: [
                { buttonId: "menu_vendas", buttonText: { displayText: "Vendas" } },
                { buttonId: "menu_fin", buttonText: { displayText: "Financeiro" } }
              ]
            },
            awaitResponse: {
              timeoutMs: 30000,
              expected: [
                {
                  key: "menu_vendas",
                  aliases: ["Vendas"],
                  action: {
                    mode: "send",
                    payload: { type: "text", text: "Acionando vendas." }
                  }
                },
                {
                  key: "menu_fin",
                  aliases: ["Financeiro"],
                  action: {
                    mode: "send",
                    payload: { type: "text", text: "Acionando financeiro." }
                  }
                }
              ],
              onTimeout: {
                action: {
                  mode: "send",
                  payload: {
                    type: "text",
                    to: "558296921589",
                    text: "Voce demorou para responder. Digite /menu para abrir novamente."
                  }
                }
              }
            }
          }
        },
        {
          name: "create_permanent_menu_command",
          method: "POST",
          endpoint: "/api/tasks/permanent",
          body: {
            to: "558296921589",
            trigger: "/menu",
            action: {
              mode: "send",
              payload: {
                type: "interactive",
                to: "558296921589",
                content: {
                  text: "Menu principal",
                  buttons: [
                    { buttonId: "m1", buttonText: { displayText: "Opcao 1" } }
                  ]
                }
              }
            }
          }
        }
      ]
    }));
  }, { prefix: "/ui/api" });
}
