import { sendText } from "./sendText.js";
import { sendInteractive } from "./sendInteractive.js";
import { sendMedia } from "./sendMedia.js";
import { sendIA } from "./sendIA.js";

const RESERVED_KEYS = new Set([
  "to",
  "type",
  "options",
  "message",
  "context"
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickContent(payload) {
  const content = {};

  for (const [key, value] of Object.entries(payload)) {
    if (!RESERVED_KEYS.has(key)) {
      content[key] = value;
    }
  }

  return content;
}

export async function sendAny(bailey, payload) {
  if (!isPlainObject(payload)) {
    throw new Error("INVALID_PAYLOAD");
  }

  const type = payload.type ? String(payload.type).toLowerCase() : "";

  if (type === "ia") {
    return sendIA(bailey, payload);
  }

  switch (type) {
    case "text":
      return sendText(bailey, payload);

    case "interactive":
      return sendInteractive(bailey, payload);

    case "media":
      return sendMedia(bailey, payload);

    case "":
      if (payload.mediaType && payload.media) {
        return sendMedia(bailey, payload);
      }

      const content = pickContent(payload);
      const contentKeys = Object.keys(content);

      if (contentKeys.length === 1 && typeof content.text === "string") {
        return sendText(bailey, {
          to: payload.to,
          text: content.text,
          options: payload.options || {}
        });
      }

      if (isPlainObject(payload.content)) {
        return sendInteractive(bailey, {
          to: payload.to,
          content: payload.content,
          options: payload.options || {}
        });
      }

      if (contentKeys.length > 0) {
        return sendInteractive(bailey, {
          to: payload.to,
          content,
          options: payload.options || {}
        });
      }

      throw new Error("INVALID_PAYLOAD_SHAPE");

    default:
      throw new Error("UNSUPPORTED_MESSAGE_TYPE");
  }
}
