// teste.js
const axios = require("axios");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

(async () => {
  try {
    const res = await axios.post(
      "https://api-midiaadtab-whatsapp.onrender.com/api/start",
      {},
      {
        headers: {
          Authorization:
            "9f3c0e2d9e7b4c9b8a1f7d4e2c6a5b0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d"
        },
        timeout: 35000
      }
    );

    console.log("Resposta da API:");
    console.log(res.data);

    // 🔥 se vier QR, gera o PNG
    if (res.data.state === "qr" && res.data.qr) {
      const outputPath = path.resolve(__dirname, "qrcode.png");

      await QRCode.toFile(outputPath, res.data.qr, {
        type: "png",
        width: 400,
        margin: 2
      });

      console.log("✅ QR Code gerado com sucesso!");
      console.log("📂 Arquivo:", outputPath);
      console.log("👉 Escaneie com o WhatsApp");
    }

    if (res.data.state === "ready") {
      console.log("✅ Bot já estava conectado, não precisa de QR");
    }

  } catch (err) {
    console.error(
      "❌ Erro:",
      err.response?.data || err.message
    );
  }
})();
