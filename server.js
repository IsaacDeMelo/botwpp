// server.js
import "dotenv/config";
import Fastify from "fastify";
import routes from "./src/routes.js";
import { createBailey } from "./src/bailey/config.js";
import { baileyGuard } from "./src/bailey/middleware.js";
import { authGuard } from "./src/middleware/authGuard.js";

const BASE_PORT = Number(process.env.PORT) || 3000;

// ===============================
// Criar app
// ===============================
function buildApp() {
  const app = Fastify({
    logger: {
      transport: {
        target: "pino-pretty",
        options: { colorize: true }
      }
    }
  });

  // ===============================
  // Bailey client
  // ===============================
  const bailey = createBailey({
    authDir: "./auth",
    browserName: "ITSUKI-API"
  });

  // ===============================
  // Decorators
  // ===============================
  app.decorate("bailey", bailey);
  app.decorate("baileyGuard", baileyGuard(bailey));

  // ===============================
  // Auth global
  // ===============================
  app.addHook("preHandler", authGuard());

  // ===============================
  // Error handler
  // ===============================
  app.setErrorHandler((error, req, reply) => {
    app.log.error(error);

    const statusCode = Number(error?.statusCode) || 500;
    const code =
      typeof error?.code === "string" && error.code
        ? error.code
        : statusCode >= 500
        ? "INTERNAL_SERVER_ERROR"
        : "REQUEST_ERROR";

    const message =
      statusCode >= 500
        ? "Internal Server Error"
        : error.message || "Request Error";

    reply
      .code(statusCode)
      .header("content-type", "application/json")
      .send({
        error: code,
        message
      });
  });

  // ===============================
  // Rotas
  // ===============================
  app.get("/", async () => ({
    status: "ok",
    service: "mid-itsuki-baileys-api",
    qrRenderFormats: [
      "png_base64",
      "png_data_url",
      "svg",
      "base64url",
      "base64",
      "raw",
      "binary"
    ]
  }));

  app.register(routes, {
    prefix: "/api",
    bailey
  });

  return app;
}

// ===============================
// Start com fallback
// ===============================
async function start(port = BASE_PORT) {
  const app = buildApp();

  try {
    await app.listen({
      port,
      host: "0.0.0.0"
    });

    app.log.info(`API rodando na porta ${port}`);

  } catch (err) {

    if (err.code === "EADDRINUSE") {
      console.warn(`⚠️ Porta ${port} ocupada, tentando ${port + 1}...`);
      return start(port + 1);
    }

    console.error(err);
    process.exit(1);
  }
}

start();
