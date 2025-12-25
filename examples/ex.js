// ex.js
require("dotenv").config();
const path = require("path");
const { send } = require("./send");

(async () => {
  try {
    const GROUP_ID = "558296921589"; // ID do grupo
    const MENTION_NUMBER = "558288516706"; // número a ser mencionado
    const TOKEN = process.env.AUTH_TOKEN;

    if (!TOKEN) {
      throw new Error("AUTH_TOKEN não encontrado no .env");
    }

    // caminho da imagem (mesma pasta do ex.js)
    const imagePath = path.resolve(__dirname, "foto.jpg");

    // mensagem com menção
    const message =
      `Teste mensagem + marcação + imagem via API Render 🚀\n\n` +
      `Olá @{${MENTION_NUMBER}}, tudo bem?\n` +
      `Esta mensagem foi enviada com imagem visível pelo bot.`;

    const result = 
    await send({
      number: GROUP_ID,
      message,
      token: TOKEN,
      imagePath
    });

    console.log("✔️ Enviado com sucesso:", result);

  } catch (err) {
    console.error("❌ Erro ao enviar mensagem:", err.message);
  }
})();
