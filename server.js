import "dotenv/config";
import Fastify from "fastify";
import routes from "./src/routes.js";
import { createBailey } from "./src/bailey/config.js";
import { baileyGuard } from "./src/bailey/middleware.js";
import { authGuard } from "./src/middleware/authGuard.js";
import { createResponseTaskService } from "./src/tasks/responseTaskService.js";
import { initTaskStore } from "./src/tasks/taskStore.js";
import { registerUiRoutes } from "./src/ui/siteRoutes.js";

const BASE_PORT = Number(process.env.PORT) || 3000;

async function buildApp() {
  const app = Fastify({
    logger: {
      transport: {
        target: "pino-pretty",
        options: { colorize: true }
      }
    }
  });

  const bailey = createBailey({
    authDir: "./auth",
    browserName: "ITSUKI-API"
  });

  await initTaskStore();
  const uiTaskService = createResponseTaskService({
    bailey,
    defaultTimeoutMs: 20_000,
    cleanupRetentionMs: 5 * 60_000
  });
  uiTaskService.start();

  app.decorate("bailey", bailey);
  app.decorate("baileyGuard", baileyGuard(bailey));

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    return payload;
  });

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

  registerUiRoutes(app, {
    bailey,
    taskService: uiTaskService
  });

  app.register(async function apiProtected(apiApp) {
    apiApp.addHook("preHandler", authGuard());

    apiApp.get("/api", async () => ({
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

    apiApp.register(routes, {
      prefix: "/api",
      bailey,
      taskService: uiTaskService
    });
  });

  return app;
}

async function start(port = BASE_PORT) {
  const app = await buildApp();

  try {
    await app.listen({
      port,
      host: "0.0.0.0"
    });

    app.log.info(`API running on port ${port}`);
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      console.warn(`Port ${port} in use, trying ${port + 1}...`);
      return start(port + 1);
    }

    console.error(err);
    process.exit(1);
  }
}

start();
