// teste.js
const axios = require("axios");

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

  } catch (err) {
    console.error(
      "Erro:",
      err.response?.data || err.message
    );
  }
})();
