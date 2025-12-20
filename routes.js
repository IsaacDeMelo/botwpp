// routes.js
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const { authServer } = require("./auth");
const {
  startBot,
  disconnectBot,
  getClient,
  getStatus,
  mediaFromFile,
  isReady,
  randomDelay
} = require("./bot");

const router = express.Router();

const upload = multer({
  dest: path.join(__dirname, "uploads"),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const safeUnlink = (file) => {
  try { fs.existsSync(file) && fs.unlinkSync(file); } catch {}
};

/**
 * 🔓 STATUS PÚBLICO DA API
 * GET /api/
 */
router.get("/", (_, res) => {
  const status = getStatus();

  res.json({
    api: "online",
    bot: status.state,
    qr: !!status.qr
  });
});

/**
 * Resolve destino
 */
function resolveChatId(input) {
  if (!input) return null;
  if (input.endsWith("@g.us")) return input;

  const clean = input.replace(/\D/g, "");

  if (clean.length >= 18 && clean.startsWith("1")) {
    return `${clean}@g.us`;
  }

  if (clean.length >= 10) {
    return `${clean}@s.whatsapp.net`;
  }

  return null;
}

/**
 * Parse de menções
 */
function parseMentions(text = "") {
  const mentions = [];

  const parsedText = text.replace(
    /@\{\s*(\d{10,15})\s*\}/g,
    (_, number) => {
      const clean = number.replace(/\D/g, "");
      mentions.push(`${clean}@s.whatsapp.net`);
      return `@${clean}`;
    }
  );

  return { text: parsedText, mentions };
}

/**
 * 🔐 ROTAS PROTEGIDAS
 */
router.post("/start", authServer, async (_, res) => {
  await startBot();
  res.json({ success: true });
});

router.post("/send", authServer, upload.single("image"), async (req, res) => {
  if (!isReady()) {
    req.file && safeUnlink(req.file.path);
    return res.status(503).json({ error: "Bot não está pronto" });
  }

  const chatId = resolveChatId(req.body.number);
  if (!chatId) {
    req.file && safeUnlink(req.file.path);
    return res.status(400).json({ error: "Destino inválido" });
  }

  const { text, mentions } = parseMentions(req.body.message || "");
  const sock = getClient();

  try {
    await randomDelay();

    if (req.file) {
      const media = await mediaFromFile(req.file.path);

      await sock.sendMessage(chatId, {
        image: media.image,
        caption: text || undefined,
        mentions: mentions.length ? mentions : undefined
      });
    } else {
      await sock.sendMessage(chatId, {
        text,
        mentions: mentions.length ? mentions : undefined
      });
    }

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: err.message });

  } finally {
    req.file && safeUnlink(req.file.path);
  }
});

/**
 * 🔌 DESCONECTA E FORÇA NOVO QR
 */
router.post("/disconnect", authServer, async (_, res) => {
  await disconnectBot();
  res.json({ success: true, state: "disconnected" });
});

module.exports = router;
