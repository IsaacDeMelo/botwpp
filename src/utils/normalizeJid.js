/**
 * Normaliza destino WhatsApp (JID)
 *
 * SUPORTA:
 * - Usuário: 5582999999999
 * - Usuário: 5582999999999@s.whatsapp.net
 * - Grupo: 123456789-123456@g.us
 * - Broadcast: 123456789@broadcast
 * - Status: status@broadcast
 */
const USER_JID_REGEX = /^\d{5,20}(?::\d+)?@s\.whatsapp\.net$/;
const GROUP_JID_REGEX = /^\d{5,40}(?:-\d{1,40})?@g\.us$/;
const BROADCAST_JID_REGEX = /^\d+@broadcast$/;
const LID_JID_REGEX = /^[^@\s]+@lid$/;

function safeJidForLog(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw.includes("@")) {
    return "<without-domain>";
  }

  const [localPart, domain] = raw.split("@");
  return `${"*".repeat(Math.min(localPart.length, 6))}@${domain}`;
}

function normalizePhoneNumber(value) {
  const number = String(value).replace(/\D/g, "");
  if (!number) {
    throw new Error("TO_INVALID");
  }
  return number;
}

export function normalizeJid(to) {
  if (!to || typeof to !== "string") {
    throw new Error("TO_INVALID");
  }

  const raw = to.trim();
  if (!raw) {
    throw new Error("TO_INVALID");
  }

  if (raw.includes("@")) {
    const jid = raw.toLowerCase();

    if (
      jid === "status@broadcast" ||
      USER_JID_REGEX.test(jid) ||
      GROUP_JID_REGEX.test(jid) ||
      BROADCAST_JID_REGEX.test(jid) ||
      LID_JID_REGEX.test(jid)
    ) {
      return jid;
    }

    console.warn("[normalizeJid] rejected jid", {
      code: "TO_INVALID_JID",
      jid: safeJidForLog(jid),
      reason: "unsupported_jid_pattern"
    });
    throw new Error("TO_INVALID_JID");
  }

  return `${normalizePhoneNumber(raw)}@s.whatsapp.net`;
}

export function extractPhoneNumber(input) {
  if (!input || typeof input !== "string") {
    return null;
  }

  const value = input.trim().toLowerCase();
  if (!value) {
    return null;
  }

  if (!value.includes("@")) {
    const localOnly = value.split(":")[0];
    const direct = localOnly.replace(/\D/g, "");
    return direct || null;
  }

  const [localPart, domain] = value.split("@");
  if (domain === "s.whatsapp.net") {
    const baseLocal = localPart.split(":")[0];
    const fromJid = baseLocal.replace(/\D/g, "");
    return fromJid || null;
  }

  return null;
}
