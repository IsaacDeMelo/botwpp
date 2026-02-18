// src/bailey/sendInteractive.js
import { normalizeJid } from "./normalizeJid.js";
import { parseMentions } from "./parseMentions.js";
import { normalizeMediaInput } from "./normalizeMediaInput.js";
/**
 * Envia QUALQUER mensagem interativa suportada pelo Baileys / Itsuki
 *
 * SUPORTA:
 * - Interactive Buttons (PIX, PAY, Galaxy, Flow, etc)
 * - Buttons Message / List / Cards
 * - Button Reply
 * - Product / Shop / Collection
 * - Location / Contact / Poll / Event / Payment
 * - Qualquer payload avancado da documentacao
 *
 * @param {BaileyClient} bailey
 * @param {Object} payload
 */
export async function sendInteractive(
  bailey,
  {
    to,

    /**
     * content = OBJETO EXATO DA DOCUMENTACAO
     * Ex:
     * {
     *   text: '',
     *   interactiveButtons: [...],
     *   title,
     *   footer,
     *   image,
     *   product,
     *   location,
     *   poll,
     *   event,
     *   shop,
     *   collection,
     *   buttons,
     *   sections,
     *   cards,
     *   etc...
     * }
     */
    content,

    /**
     * options = MiscMessageGenerationOptions
     * Ex:
     * { quoted, ai, ephemeralExpiration, messageId }
     */
    options = {}
  }
) {
  if (!to) {
    throw new Error("TO_REQUIRED");
  }

  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new Error("CONTENT_OBJECT_REQUIRED");
  }

  const sock = bailey.getSocket();
  if (!sock) {
    throw new Error("SOCKET_NOT_AVAILABLE");
  }

  // ===============================
  // NORMALIZA JID
  // ===============================
  const jid = normalizeJid(to);

  // ===============================
  // STATUS@BROADCAST
  // ===============================
  if (jid === "status@broadcast") {
    return await sock.sendStatusMentions(content, content.jids || []);
  }

  // ===============================
  // MENCOES UNIVERSAIS @{}
  // ===============================
  const safeContent = { ...content };
  let collectedMentions = [];

  for (const field of ["text", "caption", "footer", "title"]) {
    if (typeof safeContent[field] === "string") {
      const { text, mentions } = parseMentions(safeContent[field]);
      safeContent[field] = text;

      if (mentions.length) {
        collectedMentions.push(...mentions);
      }
    }
  }

  // Injeta mencoes no payload (Baileys exige isso)
  if (collectedMentions.length) {
    safeContent.mentions = Array.from(
      new Set([...(safeContent.mentions || []), ...collectedMentions])
    );
  }

  // Normaliza fontes de midia (url, data URL, svg/html inline).
  for (const mediaField of ["image", "video", "audio", "document", "sticker"]) {
    if (!safeContent[mediaField]) continue;

    const normalized = normalizeMediaInput(safeContent[mediaField]);

    if (mediaField === "image" && normalized.fromSvg) {
      safeContent.document = normalized.media;
      safeContent.fileName = safeContent.fileName || "image.svg";
      safeContent.mimetype = safeContent.mimetype || "image/svg+xml";
      delete safeContent.image;
      continue;
    }

    safeContent[mediaField] = normalized.media;
    if (!safeContent.mimetype && normalized.detectedMimeType) {
      safeContent.mimetype = normalized.detectedMimeType;
    }
  }

  const hasMedia =
    !!safeContent.image ||
    !!safeContent.video ||
    !!safeContent.audio ||
    !!safeContent.document ||
    !!safeContent.sticker;

  const hasInteractiveControls =
    (Array.isArray(safeContent.buttons) && safeContent.buttons.length > 0) ||
    (Array.isArray(safeContent.sections) && safeContent.sections.length > 0) ||
    (Array.isArray(safeContent.interactiveButtons) &&
      safeContent.interactiveButtons.length > 0) ||
    (Array.isArray(safeContent.templateButtons) &&
      safeContent.templateButtons.length > 0);

  // Fallback para clientes que nao renderizam footer separado em midia sem botoes.
  if (
    hasMedia &&
    !hasInteractiveControls &&
    typeof safeContent.footer === "string" &&
    safeContent.footer.trim()
  ) {
    const footerText = safeContent.footer.trim();
    const baseCaption =
      typeof safeContent.caption === "string" && safeContent.caption.trim()
        ? safeContent.caption
        : typeof safeContent.text === "string" && safeContent.text.trim()
        ? safeContent.text
        : "";

    safeContent.caption = baseCaption
      ? `${baseCaption}\n\n${footerText}`
      : footerText;

    delete safeContent.footer;
  }

  const result = await sock.sendMessage(jid, safeContent, options);

  return {
    to: jid,
    messageId: result?.key?.id,
    type: "interactive",
    contentType: Object.keys(safeContent)[0] || "unknown",
    status: "sent"
  };
}
