// src/bailey/sendInteractive.js
import { normalizeJid } from "./normalizeJid.js";
import { parseMentions } from "./parseMentions.js";
/**
 * Envia QUALQUER mensagem interativa suportada pelo Baileys / Itsuki
 *
 * SUPORTA:
 * - Interactive Buttons (PIX, PAY, Galaxy, Flow, etc)
 * - Buttons Message / List / Cards
 * - Button Reply
 * - Product / Shop / Collection
 * - Location / Contact / Poll / Event / Payment
 * - Qualquer payload avançado da documentação
 *
 * @param {BaileyClient} bailey
 * @param {Object} payload
 */
export async function sendInteractive(
  bailey,
  {
    to,

    /**
     * content = OBJETO EXATO DA DOCUMENTAÇÃO
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
    return await sock.sendStatusMentions(
      content,
      content.jids || []
    );
  }

  // ===============================
  // MENÇÕES EM text E caption @{numero}
  // ===============================
  // ===============================
  // MENÇÕES UNIVERSAIS @{}
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

  // Injeta menções direto no payload (Baileys exige isso)
  if (collectedMentions.length) {
    safeContent.mentions = Array.from(
      new Set([
        ...(safeContent.mentions || []),
        ...collectedMentions
      ])
    );
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
