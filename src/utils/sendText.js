// src/bailey/sendText.js

import { normalizeJid } from "./normalizeJid.js";
import { parseMentions } from "./parseMentions.js";


/**
 * Envia mensagem de texto simples
 * - suporta menções @{558296921589}
 *
 * @param {BaileyClient} bailey
 * @param {Object} payload
 */
export async function sendText(bailey, { to, text, options = {} }) {
  
  if (!to || typeof text !== "string") {
    throw new Error("TO_AND_TEXT_REQUIRED");
  }

  const sock = bailey.getSocket();
  if (!sock) {
    throw new Error("SOCKET_NOT_AVAILABLE");
  }

  const jid = normalizeJid(to);

  const { text: parsedText, mentions } = parseMentions(text);

  const result = await sock.sendMessage(
    jid,
    {
      text: parsedText,
      ...(mentions.length ? { mentions } : {})
    },
    options
  );

  return {
    to: jid,
    messageId: result?.key?.id,
    type: "text",
    mentions,
    status: "sent"
  };
}
