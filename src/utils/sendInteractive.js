// src/bailey/sendInteractive.js
import { normalizeJid } from "./normalizeJid.js";
import { parseMentions } from "./parseMentions.js";
import { normalizeMediaInput } from "./normalizeMediaInput.js";
import { normalizeSvgImageToPng } from "./svgToPng.js";
import { applyTypingPresence } from "./sendPresence.js";

/**
 * Envia payload interativo suportado pelo Baileys / Itsuki.
 */
export async function sendInteractive(
  bailey,
  {
    to,
    content,
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

  const jid = normalizeJid(to);

  if (jid === "status@broadcast") {
    return await sock.sendStatusMentions(content, content.jids || []);
  }

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

  if (collectedMentions.length) {
    safeContent.mentions = Array.from(
      new Set([...(safeContent.mentions || []), ...collectedMentions])
    );
  }

  for (const mediaField of ["image", "video", "audio", "document", "sticker"]) {
    if (!safeContent[mediaField]) continue;

    const normalized = normalizeMediaInput(safeContent[mediaField]);

    if (mediaField === "image") {
      const pngFromSvg = await normalizeSvgImageToPng(
        safeContent[mediaField],
        normalized
      );

      if (pngFromSvg?.convertedFromSvg) {
        safeContent.image = pngFromSvg.media;
        safeContent.mimetype = safeContent.mimetype || pngFromSvg.mimetype;
        continue;
      }
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
    (Array.isArray(safeContent.interactiveButtons) && safeContent.interactiveButtons.length > 0) ||
    (Array.isArray(safeContent.templateButtons) && safeContent.templateButtons.length > 0);

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

  const typingHint = safeContent.text || safeContent.caption || safeContent.footer || "";
  await applyTypingPresence(sock, jid, typingHint);

  const result = await sock.sendMessage(jid, safeContent, options);

  return {
    to: jid,
    messageId: result?.key?.id,
    type: "interactive",
    contentType: Object.keys(safeContent)[0] || "unknown",
    status: "sent"
  };
}
