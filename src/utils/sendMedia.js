// src/bailey/sendMedia.js
import { normalizeJid } from "./normalizeJid.js";
import { parseMentions } from "./parseMentions.js";
import { normalizeMediaInput } from "./normalizeMediaInput.js";

/**
 * Envia mensagens de mídia:
 * - image
 * - video
 * - audio
 * - document
 *
 * Suporta:
 * - caption / text
 * - menções @{numero}
 * - qualquer campo extra do Baileys
 *
 * @param {BaileyClient} bailey
 * @param {Object} payload
 */
export async function sendMedia(
  bailey,
  {
    to,

    // tipo da mídia (OBRIGATÓRIO)
    mediaType, // "image" | "video" | "audio" | "document"

    // conteúdo da mídia (OBRIGATÓRIO)
    media, // { url } | Buffer | Stream

    // texto opcional
    caption,
    text,

    // mimetype opcional
    mimetype,

    // flags comuns
    gifPlayback,
    ptv,
    viewOnce,
    options = {},

    // qualquer outro campo (footer, title, shop, collection, etc)
    ...extraContent
  }
) {
  if (!to || !mediaType || !media) {
    throw new Error("TO_MEDIA_TYPE_AND_MEDIA_REQUIRED");
  }

  const safeMediaType = String(mediaType).toLowerCase();
  const supportedMediaTypes = new Set([
    "image",
    "video",
    "audio",
    "document",
    "sticker"
  ]);

  if (!supportedMediaTypes.has(safeMediaType)) {
    throw new Error("UNSUPPORTED_MEDIA_TYPE");
  }

  const sock = bailey.getSocket();
  if (!sock) {
    throw new Error("SOCKET_NOT_AVAILABLE");
  }

  const jid = normalizeJid(to);
  const normalized = normalizeMediaInput(media);

  let payloadMediaType = safeMediaType;
  let payloadMedia = normalized.media;

  // WhatsApp nao renderiza SVG inline como imagem na maioria dos clientes.
  // Nesses casos, envia como documento para manter compatibilidade.
  if (safeMediaType === "image" && normalized.fromSvg) {
    payloadMediaType = "document";
  }

  // ===============================
  // BASE DO PAYLOAD
  // ===============================
  const content = {
    [payloadMediaType]: payloadMedia,
    ...extraContent
  };

  // ===============================
  // CAPTION / TEXTO + MENÇÕES
  // ===============================
  const rawCaption =
    typeof caption === "string"
      ? caption
      : typeof text === "string"
      ? text
      : null;

  if (rawCaption) {
    const { text: parsedCaption, mentions } = parseMentions(rawCaption);
    content.caption = parsedCaption;

    if (mentions.length) {
      content.mentions = mentions;
    }
  }

  // ===============================
  // FLAGS OPCIONAIS
  // ===============================
  if (mimetype) content.mimetype = mimetype;
  if (!mimetype && normalized.detectedMimeType) {
    content.mimetype = normalized.detectedMimeType;
  }
  if (payloadMediaType === "document" && !content.fileName) {
    content.fileName = normalized.fromSvg ? "image.svg" : "file";
  }
  if (gifPlayback) content.gifPlayback = true;
  if (ptv) content.ptv = true;
  if (viewOnce) content.viewOnce = true;

  const result = await sock.sendMessage(jid, content, options);

  return {
    to: jid,
    messageId: result?.key?.id,
    type: "media",
    mediaType: payloadMediaType,
    status: "sent"
  };
}
