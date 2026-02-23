const TYPING_ENABLED = String(process.env.BOT_TYPING_ENABLED ?? "true").toLowerCase() !== "false";
const TYPING_MIN_MS = Math.max(0, Number(process.env.BOT_TYPING_MIN_MS) || 280);
const TYPING_MAX_MS = Math.max(TYPING_MIN_MS, Number(process.env.BOT_TYPING_MAX_MS) || 1300);
const TYPING_CHAR_FACTOR_MS = Math.max(0, Number(process.env.BOT_TYPING_CHAR_FACTOR_MS) || 14);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateTypingMs(hintText = "") {
  const text = String(hintText || "").trim();
  const byLength = text.length * TYPING_CHAR_FACTOR_MS;
  const jitter = Math.floor(Math.random() * 120);
  return Math.min(TYPING_MAX_MS, Math.max(TYPING_MIN_MS, byLength + jitter));
}

function shouldSkipTyping(jid) {
  const value = String(jid || "").toLowerCase();
  if (!value) return true;
  if (value === "status@broadcast") return true;
  return false;
}

export async function applyTypingPresence(sock, jid, hintText = "") {
  if (!TYPING_ENABLED) return;
  if (!sock || typeof sock.sendPresenceUpdate !== "function") return;
  if (shouldSkipTyping(jid)) return;

  const waitMs = estimateTypingMs(hintText);

  try {
    await sock.sendPresenceUpdate("composing", jid);
    await sleep(waitMs);
  } catch {
    // Best-effort only: never block message delivery.
  } finally {
    try {
      await sock.sendPresenceUpdate("paused", jid);
    } catch {
      // ignore
    }
  }
}
