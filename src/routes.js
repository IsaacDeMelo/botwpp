// src/routes.js
import { sendAny } from "./utils/sendAny.js";
import QRCode from "qrcode";
import {
  getDocsIndex,
  getDocsSection,
  searchDocs
} from "./utils/itsukichanDocs.js";
import { createResponseTaskService } from "./tasks/responseTaskService.js";

function toBinaryString(text) {
  return Array.from(Buffer.from(String(text), "utf-8"))
    .map((b) => b.toString(2).padStart(8, "0"))
    .join("");
}

export default async function routes(app, opts) {
  const { bailey } = opts;
  const taskService = createResponseTaskService({
    bailey,
    defaultTimeoutMs: 20_000,
    cleanupRetentionMs: 5 * 60_000
  });
  taskService.start();

  // ===============================
  // ROTAS (TODAS JÁ PROTEGIDAS)
  // ===============================
  app.post("/bailey/start", async () => {
    await bailey.start();
    return { status: "starting" };
  });

  app.get("/bailey/status", async () => ({
    status: bailey.getStatus()
  }));

  app.get("/bailey/qr", async () => ({
    qr: bailey.getQRCode()
  }));

  app.get("/bailey/qr/render", async (req, reply) => {
    const qr = bailey.getQRCode();
    if (!qr) {
      return reply.code(404).send({
        error: "QR_NOT_AVAILABLE"
      });
    }

    const format = String(req.query?.format || "png_base64").toLowerCase();
    const width = Math.min(Math.max(Number(req.query?.width) || 350, 128), 2048);
    const margin = Math.min(Math.max(Number(req.query?.margin) || 2, 0), 16);

    try {
      switch (format) {
        case "raw":
          return { format, qr };

        case "base64":
          return { format, value: Buffer.from(qr, "utf-8").toString("base64") };

        case "base64url":
          return { format, value: Buffer.from(qr, "utf-8").toString("base64url") };

        case "binary":
          return { format, value: toBinaryString(qr) };

        case "svg": {
          const svg = await QRCode.toString(qr, {
            type: "svg",
            margin
          });
          return { format, svg };
        }

        case "png_data_url": {
          const dataUrl = await QRCode.toDataURL(qr, {
            width,
            margin
          });
          return { format, dataUrl };
        }

        case "png_base64":
        default: {
          const dataUrl = await QRCode.toDataURL(qr, {
            width,
            margin
          });
          const base64 = dataUrl.split(",")[1] || "";
          return {
            format: "png_base64",
            mime: "image/png",
            base64
          };
        }
      }
    } catch (error) {
      return reply.code(500).send({
        error: "QR_RENDER_FAILED",
        message: error.message
      });
    }
  });

  // ===============================
  // DOCS ITSUKICHAN (PESQUISA)
  // ===============================
  app.get("/docs/index", async (req, reply) => {
    try {
      const { q = "", level } = req.query || {};
      const items = getDocsIndex({ q, level });
      return {
        total: items.length,
        items
      };
    } catch (error) {
      return reply.code(400).send({
        error: error.message
      });
    }
  });

  app.get("/docs/section", async (req, reply) => {
    try {
      const { title = "", anchor = "" } = req.query || {};
      const section = getDocsSection({ title, anchor });

      if (!section) {
        return reply.code(404).send({
          error: "DOCS_SECTION_NOT_FOUND"
        });
      }

      return section;
    } catch (error) {
      return reply.code(400).send({
        error: error.message
      });
    }
  });

  app.get("/docs/search", async (req, reply) => {
    try {
      const { q = "", limit = 10, level } = req.query || {};
      const items = searchDocs({ q, limit, level });
      return {
        total: items.length,
        items
      };
    } catch (error) {
      return reply.code(400).send({
        error: error.message
      });
    }
  });

  // ===============================
  // TAREFAS DE RESPOSTA (WEBHOOK)
  // ===============================
  app.get("/tasks", async (req) => {
    const { status, to } = req.query || {};
    const items = taskService.list({ status, to });
    return {
      total: items.length,
      items
    };
  });

  app.get("/tasks/:id", async (req, reply) => {
    const task = taskService.get(req.params.id);
    if (!task) {
      return reply.code(404).send({
        error: "TASK_NOT_FOUND"
      });
    }
    return task;
  });

  app.post("/tasks/:id/cancel", async (req, reply) => {
    const task = taskService.cancel(req.params.id);
    if (!task) {
      return reply.code(404).send({
        error: "TASK_NOT_FOUND"
      });
    }
    return task;
  });

  app.delete("/tasks/:id", async (req, reply) => {
    const removed = taskService.remove(req.params.id);
    if (!removed) {
      return reply.code(404).send({
        error: "TASK_NOT_FOUND"
      });
    }
    return { status: "deleted" };
  });

  // ===============================
  // ROTAS QUE EXIGEM BAILEY ONLINE
  // ===============================
  app.register(async function protectedRoutes(protectedApp) {

    // apenas o guard do Bailey agora
    protectedApp.addHook("preHandler", protectedApp.baileyGuard);

    protectedApp.post("/bailey/restart", async () => {
      await bailey.restart();
      return { status: "restarting" };
    });

    protectedApp.post("/bailey/logout", async () => {
      await bailey.logout();
      await bailey.start();
      return { status: "restarting_session" };
    });

    protectedApp.post("/bailey/shutdown", async () => {
      await bailey.stop();
      return { status: "stopped" };
    });

    protectedApp.post("/send", async (req, reply) => {
      const result = await sendAny(bailey, req.body);

      try {
        const task = taskService.createFromSend({
          requestBody: req.body,
          sendResult: result
        });

        return {
          ...result,
          ...(task
            ? {
                awaitResponse: {
                  taskId: task.id,
                  status: task.status,
                  expiresAt: task.expiresAt
                }
              }
            : {})
        };
      } catch (error) {
        return reply.code(400).send({
          error: error.message
        });
      }
    });
  });
}
