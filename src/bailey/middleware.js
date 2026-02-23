import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { extractPhoneNumber } from "../utils/normalizeJid.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BLACKLIST_DIR = path.resolve(__dirname, "../blacklist");

const blacklistWords = JSON.parse(
  fs.readFileSync(path.join(BLACKLIST_DIR, "words.json"), "utf-8")
);

const blacklistNumbers = JSON.parse(
  fs.readFileSync(path.join(BLACKLIST_DIR, "numbers.json"), "utf-8")
);
const blacklistNumbersSet = new Set(
  blacklistNumbers
    .map(extractPhoneNumber)
    .filter(Boolean)
);

function collectBodyTexts(body) {
  const texts = [];
  const stack = [body];
  const seen = new Set();

  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);

    for (const [key, value] of Object.entries(current)) {
      if (typeof value === "string") {
        if (["text", "message", "caption", "title", "footer"].includes(key)) {
          texts.push(value);
        }
      } else if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }

  return texts;
}

export function baileyGuard(bailey) {
  return async function (req, reply) {

    const status = bailey.getStatus();

    // BOT NÃO INICIADO
    if (status === "idle") {
      return reply.code(409).send({
        error: "BOT_NOT_STARTED",
        message: "Inicie o cliente antes de usar"
      });
    }

    // PRECISA ESCANEAR QR
    if (status === "connecting") {
      return reply.code(428).send({
        error: "QR_REQUIRED",
        message: "Escaneie o QR Code para continuar"
      });
    }

    // LOGOUT
    if (status === "logged_out") {
      return reply.code(401).send({
        error: "LOGGED_OUT",
        message: "Sessão encerrada. Escaneie novamente."
      });
    }

    // OFFLINE
    if (status !== "connected") {
      return reply.code(503).send({
        error: "BOT_OFFLINE"
      });
    }

    const { to } = req.body || {};

    // blacklist por número (normalizado para evitar bypass com JID)
    const targetNumber = extractPhoneNumber(to);
    if (targetNumber && blacklistNumbersSet.has(targetNumber)) {
      return reply.code(403).send({
        error: "NUMBER_BLOCKED",
        to
      });
    }

    // blacklist por palavra (inclui payloads interativos/content)
    const texts = collectBodyTexts(req.body || {});
    for (const content of texts) {
      const found = blacklistWords.find((word) =>
        content.toLowerCase().includes(word.toLowerCase())
      );

      if (found) {
        return reply.code(403).send({
          error: "WORD_BLOCKED",
          word: found
        });
      }
    }
  };
}
