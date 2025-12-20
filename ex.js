// ex.js
require("dotenv").config();
const { send } = require("./send");

(async () => {
  try {
    const GROUP_ID = "120363421971166966"; // ID do grupo
    const MENTION_NUMBER = "558288516706"; // número a ser mencionado
    const TOKEN = process.env.AUTH_TOKEN;

    if (!TOKEN) {
      throw new Error("AUTH_TOKEN não encontrado no .env");
    }

    // mensagem simples com apenas UMA marcação
    const message = `Olá @{${MENTION_NUMBER}}, tudo bem? 
Estou falando via API do WhatsApp hospedada no Render 🚀`;

    const result = await send({
      number: GROUP_ID,
      message,
      token: TOKEN
    });

    console.log("✔️ Enviado com sucesso:", result);

  } catch (err) {
    console.error("❌ Erro ao enviar mensagem:", err.message);
  }
})();
