// send.js
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");

/**
 * Envia mensagem via API do WhatsApp
 * @param {Object} params
 * @param {string} params.number - Número do destinatário (ex: 558299999999)
 * @param {string} params.message - Texto da mensagem (suporta @{numero})
 * @param {string} params.token - Token de autenticação (OBRIGATÓRIO)
 * @param {string} [params.imagePath] - Caminho da imagem (opcional)
 * @param {string} [params.apiUrl] - URL da API (opcional)
 */
async function send({
  number,
  message,
  token,
  imagePath = null,
  apiUrl = "http://localhost:3006/api/send"
}) {
  if (!number) {
    throw new Error("Parâmetro 'number' é obrigatório");
  }

  if (!message) {
    throw new Error("Parâmetro 'message' é obrigatório");
  }

  if (!token) {
    throw new Error("Parâmetro 'token' é obrigatório");
  }

  const form = new FormData();
  form.append("number", number);
  form.append("message", message);

  if (imagePath) {
    const resolvedPath = path.resolve(imagePath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Imagem não encontrada: ${resolvedPath}`);
    }

    form.append("image", fs.createReadStream(resolvedPath));
  }

  try {
    const response = await axios.post(apiUrl, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: token
      }
    });

    return response.data;

  } catch (err) {
    const error = err.response?.data || err.message;
    throw new Error(
      typeof error === "string" ? error : JSON.stringify(error)
    );
  }
}

module.exports = {
  send
};
