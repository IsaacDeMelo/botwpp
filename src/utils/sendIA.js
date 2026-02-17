// src/utils/sendIA.js

import { sendText } from "./sendText.js";
import { sendMedia } from "./sendMedia.js";
import { sendInteractive } from "./sendInteractive.js";

const API_URL = "https://apifreellm.com/api/v1/chat";
const API_KEY = process.env.APIFREELLM_API_KEY;
const MAX_RETRIES = 3;
const ALLOWED_MEDIA_TYPES = new Set([
  "image",
  "video",
  "audio",
  "document",
  "sticker"
]);

/* ===============================
   BLOQUEIO DE IDENTIDADE
================================ */
const FORBIDDEN_PATTERNS = [
  /llama/i,
  /meta/i,
  /openai/i,
  /deepseek/i,
  /language model/i,
  /trained by/i,
  /as an ai/i,
  /sou um modelo/i
];

function hasForbiddenContent(text) {
  return FORBIDDEN_PATTERNS.some(r => r.test(text));
}

function isValidProtocol(text) {
  return /^(T|M|I)\|/.test(text);
}

/* ===============================
   PARSER SIMPLIFICADO
================================ */
function parseInteractive(raw) {
  // Garante ; antes de btn= ou list=
  raw = raw.replace(
    /(text=[^;]+)\s+(btn=|list=)/i,
    "$1;$2"
  );

  const content = {
    text: "Escolha uma opção:",
    title: "Menu",
    buttonText: "Ver opções",
    footer: "",
    buttons: [],
    sections: []
  };

  // remove I|
  const body = raw.slice(2);

  // separa por ;
  const parts = body.split(";");

  for (const part of parts) {

    const [key, value] = part.split("=");

    if (!key || !value) continue;

    const k = key.trim().toLowerCase();
    const v = value.trim();

    /* TEXTO */
    if (k === "text") {
      content.text = v;
    }

    /* BOTÕES */
    if (k === "btn" || k === "buttons") {

      const items = v.split(",");

      items.forEach((item, i) => {
        content.buttons.push({
          buttonId: `btn_${i + 1}`,
          buttonText: {
            displayText: item.trim()
          }
        });
      });
    }

    /* LISTA */
    if (k === "list") {

      const items = v.split(",");

      content.sections.push({
        title: "Opções",
        rows: items.map((item, i) => ({
          title: item.trim(),
          rowId: `opt_${i + 1}`
        }))
      });
    }
  }

  /* ===============================
     LIMPEZA AUTOMÁTICA
  ================================ */

    /* ===============================
     DETECTA TIPO
  ================================ */

  const hasList =
    Array.isArray(content.sections) &&
    content.sections.length > 0;

  const hasButtons =
    Array.isArray(content.buttons) &&
    content.buttons.length > 0;

  /* ===============================
     LIMPEZA SEGURA
  ================================ */

  // Se for LISTA
  if (hasList) {
    delete content.buttons;
  }

  // Se for BOTÃO
  if (hasButtons && !hasList) {
    delete content.sections;
    delete content.title;
    delete content.buttonText;
  }


  return content;
}

/* ===============================
   MAIN
================================ */
export async function sendIA(bailey, payload) {

  const { to, message, context = "" } = payload;

  if (!API_KEY) throw new Error("APIFREELLM_API_KEY_NOT_SET");
  if (!to || !message) throw new Error("IA_PAYLOAD_INVALID");

  console.log("📥 SENDIA TO:", to);

  const prompt = `
VOCÊ É UM BOT DE WHATSAPP.

REGRAS:
- UMA LINHA
- SEM EXPLICAÇÃO
- SEM JSON
- SEM ASPAS

FORMATOS:

Texto:
T|Mensagem

Midia:
M|tipo|url|mimetype|legenda

Botões:
I|text=Mensagem;btn=Op1,Op2,Op3

Lista:
I|text=Mensagem;list=Op1,Op2,Op3

CONTEXTO:
${context}

USUÁRIO:
${message}

RESPONDA SOMENTE NO FORMATO E SEMPRE use ; entre campos. Nunca escreva list= ou btn= dentro do texto.

`.trim();

  let lastError;

  for (let i = 1; i <= MAX_RETRIES; i++) {

    try {

      console.log(`🤖 IA tentativa ${i}/${MAX_RETRIES}`);

      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`
        },
        body: JSON.stringify({ message: prompt })
      });

      const bodyText = await res.text();
      let data = {};

      try {
        data = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        if (!res.ok) {
          throw new Error(`IA_HTTP_${res.status}`);
        }
        throw new Error("IA_INVALID_JSON");
      }

      if (!res.ok) {
        throw new Error(`IA_HTTP_${res.status}`);
      }

      let raw =
        data?.response ||
        data?.data?.response ||
        data?.message ||
        "";

      raw = String(raw).trim();

      console.log("🤖 IA RAW:", raw);

      if (!raw) throw new Error("EMPTY");
      if (!isValidProtocol(raw)) throw new Error("INVALID_PROTOCOL");
      if (hasForbiddenContent(raw)) throw new Error("HALLUCINATION");

      const type = raw[0];

      /* TEXTO */
      if (type === "T") {

        return sendText(bailey, {
          to,
          text: raw.slice(2)
        });
      }

      /* MIDIA */
      if (type === "M") {

        const parts = raw.slice(2).split("|");

        const [mediaTypeRaw, urlRaw, mimetypeRaw, ...cap] = parts;
        const mediaType = String(mediaTypeRaw || "").trim().toLowerCase();
        const url = String(urlRaw || "").trim();
        const mimetype = String(mimetypeRaw || "").trim();

        if (!ALLOWED_MEDIA_TYPES.has(mediaType) || !url) {
          throw new Error("INVALID_MEDIA_PROTOCOL");
        }

        return sendMedia(bailey, {
          to,
          mediaType,
          media: { url },
          ...(mimetype ? { mimetype } : {}),
          caption: cap.join("|")
        });
      }

      /* INTERACTIVE */
      if (type === "I") {

        const content = parseInteractive(raw);

        return sendInteractive(bailey, {
          to,
          content
        });
      }

      throw new Error("UNSUPPORTED");

    } catch (err) {

      lastError = err;

      console.warn("⚠️ IA erro:", err.message);
    }
  }

  console.error("❌ IA falhou:", lastError?.message);

  return sendText(bailey, {
    to,
    text: "⚠️ Não consegui responder agora. Tente novamente."
  });
}
