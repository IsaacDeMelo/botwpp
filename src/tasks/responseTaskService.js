import { randomUUID } from "crypto";
import { extractPhoneNumber, normalizeJid } from "../utils/normalizeJid.js";
import { sendAny } from "../utils/sendAny.js";
import {
  getAllTasks,
  getTaskById,
  removeTask,
  saveTask,
  updateTask
} from "./taskStore.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_ACTION_TIMEOUT_MS = 8_000;
const DEFAULT_CLEANUP_RETENTION_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_ACTION_RETRY_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_ACTION_RETRY_DELAY_MS = 1200;
const TASK_DEBUG = String(process.env.TASK_DEBUG || "").toLowerCase() === "true";

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTimestampBR(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} | ${hh}:${min}`;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function unwrapMessageContent(messageContent) {
  let current = messageContent && typeof messageContent === "object"
    ? messageContent
    : {};

  const wrappers = [
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "documentWithCaptionMessage"
  ];

  let moved = true;
  while (moved) {
    moved = false;
    for (const key of wrappers) {
      const nested = current?.[key]?.message;
      if (nested && typeof nested === "object") {
        current = nested;
        moved = true;
        break;
      }
    }
  }

  return current;
}

function parseResponseFromMessage(message) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const content = unwrapMessageContent(message.message || {});
  const contextInfo =
    content?.buttonsResponseMessage?.contextInfo ||
    content?.listResponseMessage?.contextInfo ||
    content?.templateButtonReplyMessage?.contextInfo ||
    content?.interactiveResponseMessage?.contextInfo ||
    content?.extendedTextMessage?.contextInfo ||
    {};

  const replyToMessageId = String(contextInfo?.stanzaId || "").trim();

  const buttonId = content?.buttonsResponseMessage?.selectedButtonId;
  const buttonText = content?.buttonsResponseMessage?.selectedDisplayText;
  if (buttonId || buttonText) {
    return {
      key: String(buttonId || ""),
      text: String(buttonText || ""),
      replyToMessageId
    };
  }

  const rowId = content?.listResponseMessage?.singleSelectReply?.selectedRowId;
  const rowTitle = content?.listResponseMessage?.title;
  if (rowId || rowTitle) {
    return {
      key: String(rowId || ""),
      text: String(rowTitle || ""),
      replyToMessageId
    };
  }

  const templateButtonId = content?.templateButtonReplyMessage?.selectedId;
  const templateButtonText = content?.templateButtonReplyMessage?.selectedDisplayText;
  if (templateButtonId || templateButtonText) {
    return {
      key: String(templateButtonId || ""),
      text: String(templateButtonText || ""),
      replyToMessageId
    };
  }

  const interactive = content?.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (interactive?.paramsJson) {
    try {
      const parsed = JSON.parse(interactive.paramsJson);
      return {
        key: String(parsed?.id || parsed?.selection_id || ""),
        text: String(parsed?.title || parsed?.text || ""),
        replyToMessageId
      };
    } catch {
      // ignore
    }
  }

  const text =
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    "";

  if (text) {
    return {
      key: "",
      text: String(text),
      replyToMessageId
    };
  }

  return null;
}

function inferExpectedFromContent(content) {
  const expected = [];
  if (!content || typeof content !== "object") {
    return expected;
  }

  if (Array.isArray(content.buttons)) {
    for (const b of content.buttons) {
      const key = String(b?.buttonId || "").trim();
      const text = String(b?.buttonText?.displayText || "").trim();
      if (!key && !text) continue;
      expected.push({
        key,
        aliases: text ? [text] : []
      });
    }
  }

  if (Array.isArray(content.sections)) {
    for (const section of content.sections) {
      const rows = Array.isArray(section?.rows) ? section.rows : [];
      for (const row of rows) {
        const key = String(row?.rowId || "").trim();
        const text = String(row?.title || "").trim();
        if (!key && !text) continue;
        expected.push({
          key,
          aliases: text ? [text] : []
        });
      }
    }
  }

  if (Array.isArray(content.interactiveButtons)) {
    for (const item of content.interactiveButtons) {
      const params = item?.buttonParamsJson;
      if (!params) continue;
      try {
        const parsed = JSON.parse(params);
        const key = String(parsed?.id || parsed?.selection_id || "").trim();
        const text = String(parsed?.display_text || "").trim();
        if (!key && !text) continue;
        expected.push({
          key,
          aliases: text ? [text] : []
        });
      } catch {
        // ignore
      }
    }
  }

  return expected;
}

function normalizeExpected(expected = []) {
  return expected
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const key = String(item.key || "").trim();
      const aliases = Array.isArray(item.aliases)
        ? item.aliases.map((a) => String(a || "").trim()).filter(Boolean)
        : [];
      return {
        key,
        aliases,
        action: item.action && typeof item.action === "object" ? item.action : null
      };
    })
    .filter((item) => item.key || item.aliases.length);
}

function resolveSenderJid(message) {
  const remoteJid = message?.key?.remoteJid;
  const participant = message?.key?.participant;

  if (!remoteJid) return null;
  if (remoteJid.endsWith("@g.us")) {
    return participant || null;
  }

  return remoteJid;
}

function inferScopeFromJid(jid) {
  const value = String(jid || "").toLowerCase();
  if (value === "status@broadcast") return "status";
  if (value.endsWith("@g.us")) return "group";
  if (value.endsWith("@broadcast")) return "broadcast";
  return "private";
}

function matchesExpected(expected, response) {
  const responseKey = normalizeText(response?.key);
  const responseText = normalizeText(response?.text);

  for (const item of expected) {
    const key = normalizeText(item.key);
    if (key && responseKey && key === responseKey) {
      return item;
    }

    const aliases = item.aliases.map(normalizeText);
    if (responseText && aliases.some((alias) => alias === responseText || responseText.includes(alias))) {
      return item;
    }

    if (responseKey && aliases.some((alias) => alias === responseKey || responseKey.includes(alias))) {
      return item;
    }
  }

  return null;
}

function sameActor(taskTo, senderJid) {
  const taskToLower = String(taskTo || "").toLowerCase();
  const senderLower = String(senderJid || "").toLowerCase();
  if (taskToLower && senderLower && taskToLower === senderLower) {
    return true;
  }

  const taskNumber = extractPhoneNumber(taskToLower);
  const senderNumber = extractPhoneNumber(senderLower);

  if (taskNumber && senderNumber) {
    return taskNumber === senderNumber;
  }

  return false;
}

function logTaskDebug(message) {
  if (!TASK_DEBUG) return;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  console.log(`[TASK ${hh}:${mm}:${ss}] ${message}`);
}

function logTaskRelated(senderJid, contentText, isRelated) {
  const when = formatTimestampBR(new Date());
  const text = String(contentText || "<no-content>");
  console.log(
    `${when} Message from [${senderJid}]: ${text} | TASK_RELATED=${isRelated ? "true" : "false"}`
  );
}

async function runWebhook(action, context) {
  if (!action || typeof action !== "object" || !action.url) {
    return null;
  }

  const method = String(action.method || "POST").toUpperCase();
  const timeoutMs = Number(action.timeoutMs) || DEFAULT_ACTION_TIMEOUT_MS;
  const headers = {
    "Content-Type": "application/json",
    ...(action.headers && typeof action.headers === "object" ? action.headers : {})
  };

  const body =
    action.body && typeof action.body === "object"
      ? {
          ...action.body,
          _taskContext: context
        }
      : {
          _taskContext: context
        };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(action.url, {
      method,
      headers,
      ...(method !== "GET" ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal
    });

    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body: text.slice(0, 2000)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runLocalSendAction({ bailey, action, context, onCreateTask }) {
  const payload = action?.payload && typeof action.payload === "object"
    ? { ...action.payload }
    : null;

  if (!payload) {
    return {
      ok: false,
      error: "ACTION_PAYLOAD_REQUIRED"
    };
  }

  payload.to = payload.to || action?.to || context?.to;

  try {
    const result = await sendAny(bailey, payload);
    let createdTask = null;

    if (onCreateTask && payload.awaitResponse) {
      createdTask = onCreateTask({
        requestBody: payload,
        sendResult: result,
        parentTaskId: context?.taskId || null
      });
    }

    return {
      ok: true,
      mode: "send",
      result,
      createdTaskId: createdTask?.id || null
    };
  } catch (error) {
    return {
      ok: false,
      mode: "send",
      error: error.message
    };
  }
}

async function runAction({ bailey, action, context, onCreateTask }) {
  if (!action || typeof action !== "object") {
    return null;
  }

  const mode = String(action.mode || "").toLowerCase();
  if (mode === "send") {
    return runLocalSendAction({
      bailey,
      action,
      context,
      onCreateTask
    });
  }

  if (action.url) {
    return runWebhook(action, context);
  }

  if (mode === "none") {
    return {
      ok: true,
      mode: "none"
    };
  }

  return {
    ok: false,
    error: "INVALID_ACTION"
  };
}

async function runActionWithRetries({
  bailey,
  action,
  context,
  onCreateTask,
  attempts,
  delayMs
}) {
  let lastResult = null;
  let tries = Math.max(1, Number(attempts) || 1);

  while (tries > 0) {
    lastResult = await runAction({
      bailey,
      action,
      context,
      onCreateTask
    });

    if (lastResult?.ok) {
      return {
        ...lastResult,
        _attemptsUsed: (Number(attempts) || 1) - tries + 1
      };
    }

    tries -= 1;
    if (tries > 0 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return {
    ...(lastResult || {}),
    _attemptsUsed: Math.max(1, Number(attempts) || 1)
  };
}

function resolveTaskTimeoutMs(rawTimeoutMs, fallbackMs, persistent = false) {
  if (persistent) {
    return null;
  }

  if (rawTimeoutMs === null || rawTimeoutMs === false) {
    return null;
  }

  if (rawTimeoutMs === undefined || rawTimeoutMs === "") {
    return fallbackMs;
  }

  const parsed = Number(rawTimeoutMs);
  if (!Number.isFinite(parsed)) {
    return fallbackMs;
  }

  if (parsed <= 0) {
    return null;
  }

  return Math.floor(parsed);
}

function resolveTaskExpiresAtMs(task) {
  const explicitExpiresAtMs = Number(task?.expiresAtMs);
  if (Number.isFinite(explicitExpiresAtMs) && explicitExpiresAtMs > 0) {
    return explicitExpiresAtMs;
  }

  const expiresAtIso = String(task?.expiresAt || "").trim();
  if (expiresAtIso) {
    const parsed = Date.parse(expiresAtIso);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const timeoutMs = Number(task?.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }

  const createdAtMs = Number(task?.createdAtMs);
  if (Number.isFinite(createdAtMs) && createdAtMs > 0) {
    return createdAtMs + timeoutMs;
  }

  const createdAtIso = String(task?.createdAt || "").trim();
  if (!createdAtIso) {
    return null;
  }

  const createdParsed = Date.parse(createdAtIso);
  if (!Number.isFinite(createdParsed) || createdParsed <= 0) {
    return null;
  }

  return createdParsed + timeoutMs;
}

export function createResponseTaskService({
  bailey,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  cleanupRetentionMs = DEFAULT_CLEANUP_RETENTION_MS,
  timeoutActionRetryAttempts = Number(process.env.TIMEOUT_ACTION_RETRY_ATTEMPTS) || DEFAULT_TIMEOUT_ACTION_RETRY_ATTEMPTS,
  timeoutActionRetryDelayMs = Number(process.env.TIMEOUT_ACTION_RETRY_DELAY_MS) || DEFAULT_TIMEOUT_ACTION_RETRY_DELAY_MS
}) {
  if (!bailey) {
    throw new Error("BAILEY_REQUIRED");
  }

  const timeoutMs = Number(defaultTimeoutMs) || DEFAULT_TIMEOUT_MS;
  const retentionMs = Number(cleanupRetentionMs) || DEFAULT_CLEANUP_RETENTION_MS;
  let started = false;
  let interval = null;
  let loopRunning = false;

  const cancelOtherTemporaryTasks = ({ to, exceptTaskId = null, reason = "superseded" }) => {
    const normalizedTo = normalizeJid(to);
    const tasks = getAllTasks().filter(
      (t) =>
        ["pending", "attending"].includes(t.status) &&
        t.to === normalizedTo &&
        (!exceptTaskId || t.id !== exceptTaskId)
    );

    for (const task of tasks) {
      updateTask(task.id, {
        status: "cancelled",
        cancelledAt: new Date().toISOString(),
        notes: [task.notes, `auto_cancel_reason:${reason}`].filter(Boolean).join(" | ")
      });
    }
  };

  const createTaskFromSend = ({ requestBody, sendResult, parentTaskId = null }) => {
    const cfg = requestBody?.awaitResponse;
    if (!cfg || cfg === false) {
      return null;
    }

    const to = normalizeJid(requestBody?.to || sendResult?.to);
    const persistent = Boolean(cfg.persistent);
    const ttl = resolveTaskTimeoutMs(cfg.timeoutMs, timeoutMs, persistent);
    const createdAtMs = nowMs();

    const inferredContent =
      requestBody?.content && typeof requestBody.content === "object"
        ? requestBody.content
        : null;

    const inferred = inferExpectedFromContent(inferredContent);
    const expected = normalizeExpected(
      Array.isArray(cfg.expected) && cfg.expected.length ? cfg.expected : inferred
    );

    if (!expected.length) {
      throw new Error("AWAIT_RESPONSE_EXPECTED_REQUIRED");
    }

    if (!persistent) {
      cancelOtherTemporaryTasks({
        to,
        exceptTaskId: parentTaskId,
        reason: "new_temporary_task_created"
      });
    }

    const task = {
      id: randomUUID(),
      status: persistent ? "persistent" : "pending",
      to,
      scope: inferScopeFromJid(to),
      requestBodyType: requestBody?.type || "auto",
      sentMessageId: sendResult?.messageId || null,
      expected,
      onTimeout:
        cfg?.onTimeout && typeof cfg.onTimeout === "object"
          ? cfg.onTimeout
          : null,
      createdAt: new Date(createdAtMs).toISOString(),
      createdAtMs,
      expiresAt: ttl ? new Date(createdAtMs + ttl).toISOString() : null,
      expiresAtMs: ttl ? createdAtMs + ttl : null,
      timeoutMs: ttl,
      updatedAt: new Date(createdAtMs).toISOString(),
      notes: cfg?.notes ? String(cfg.notes) : null,
      triggerCount: 0,
      lastTriggeredAt: null
    };

    saveTask(task);
    console.log(
      `${formatTimestampBR(new Date())} TASK_CREATED id=${task.id} status=${task.status} to=${task.to} sentMessageId=${task.sentMessageId || "-"} timeoutMs=${task.timeoutMs ?? "none"}`
    );
    return task;
  };

  const expirePendingTasks = async () => {
    const tasks = getAllTasks();
    const now = nowMs();

    for (const task of tasks) {
      if (!["pending", "attending"].includes(task.status)) continue;

      const resolvedExpiresAtMs = resolveTaskExpiresAtMs(task);
      if (!resolvedExpiresAtMs || resolvedExpiresAtMs > now) {
        if (
          resolvedExpiresAtMs &&
          (!Number(task.expiresAtMs) || Number(task.expiresAtMs) !== resolvedExpiresAtMs)
        ) {
          updateTask(task.id, {
            expiresAtMs: resolvedExpiresAtMs,
            expiresAt: task.expiresAt || new Date(resolvedExpiresAtMs).toISOString()
          });
        }
        continue;
      }

      const updated = updateTask(task.id, {
        status: "expired",
        expiredAt: new Date().toISOString(),
        expiresAtMs: resolvedExpiresAtMs,
        expiresAt: task.expiresAt || new Date(resolvedExpiresAtMs).toISOString()
      });

      if (!updated?.onTimeout?.action) {
        continue;
      }

      let timeoutActionResult = null;
      try {
        timeoutActionResult = await runActionWithRetries({
          bailey,
          action: updated.onTimeout.action,
          context: {
            taskId: updated.id,
            to: updated.to,
            reason: "timeout"
          },
          onCreateTask: createTaskFromSend,
          attempts: timeoutActionRetryAttempts,
          delayMs: timeoutActionRetryDelayMs
        });
      } catch (error) {
        timeoutActionResult = {
          ok: false,
          error: error?.message || "TIMEOUT_ACTION_FAILED"
        };
      }

      const previousActionResult =
        updated.actionResult && typeof updated.actionResult === "object"
          ? updated.actionResult
          : {};

      updateTask(updated.id, {
        actionResult: {
          ...previousActionResult,
          timeout: timeoutActionResult
        }
      });

      if (timeoutActionResult?.ok) {
        console.log(
          `${formatTimestampBR(new Date())} TASK_TIMEOUT_ACTION_OK id=${updated.id} to=${updated.to} attempts=${timeoutActionResult._attemptsUsed || 1}`
        );
      } else {
        console.error(
          `${formatTimestampBR(new Date())} TASK_TIMEOUT_ACTION_FAILED id=${updated.id} to=${updated.to} error=${timeoutActionResult?.error || "unknown"}`
        );
      }
    }
  };

  const runMaintenanceLoop = async () => {
    if (loopRunning) return;
    loopRunning = true;
    try {
      await expirePendingTasks();
      cleanupFinishedTasks();
    } finally {
      loopRunning = false;
    }
  };

  const cleanupFinishedTasks = () => {
    const tasks = getAllTasks();
    const now = nowMs();

    for (const task of tasks) {
      if (!["completed", "expired", "cancelled"].includes(task.status)) {
        continue;
      }

      const refIso =
        task.completedAt ||
        task.expiredAt ||
        task.cancelledAt ||
        task.updatedAt ||
        task.createdAt;

      const refMs = refIso ? Date.parse(refIso) : NaN;
      if (!Number.isFinite(refMs)) {
        continue;
      }

      if (now - refMs >= retentionMs) {
        removeTask(task.id);
      }
    }
  };

  const onMessagesUpsert = async (event) => {
    const list = Array.isArray(event?.messages) ? event.messages : [];

    for (const message of list) {
      try {
        if (!message || message.key?.fromMe) continue;

        const senderJid = resolveSenderJid(message);
        if (!senderJid) continue;

        const response = parseResponseFromMessage(message);
        if (!response) {
          logTaskRelated(senderJid, "<no-parseable-content>", false);
          continue;
        }

        const normalizedSender = (() => {
          try {
            return normalizeJid(senderJid);
          } catch {
            return String(senderJid || "").toLowerCase();
          }
        })();

        const now = nowMs();
        const activeTasks = getAllTasks()
          .filter((t) => ["pending", "persistent"].includes(t.status))
          .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));

        const pendingTasks = activeTasks.filter((t) => t.status === "pending");

        let tasks = [];
        if (response.replyToMessageId) {
          const byMessageId = pendingTasks.filter((t) => {
            if (!t.sentMessageId) return false;
            return String(t.sentMessageId) === String(response.replyToMessageId);
          });
          if (byMessageId.length > 0) {
            tasks = byMessageId;
          }
        }

        if (tasks.length === 0) {
          tasks = activeTasks.filter((t) => sameActor(t.to, normalizedSender));
        }

        if (tasks.length === 0) {
          const byExpected = activeTasks.filter((t) => matchesExpected(t.expected || [], response));
          if (byExpected.length === 1) {
            tasks = byExpected;
            logTaskDebug(
              `fallback_by_expected task=${byExpected[0].id} sender=${normalizedSender}`
            );
          }
        }

        logTaskRelated(senderJid, response.text || response.key || "<no-content>", tasks.length > 0);

        logTaskDebug(
          `msg sender=${normalizedSender} key=${response.key || "-"} text=${response.text || "-"} stanza=${response.replyToMessageId || "-"} active=${activeTasks.length} candidates=${tasks.length}`
        );

        for (const task of tasks) {
          if (task.status === "pending" && task.expiresAtMs && task.expiresAtMs <= now) {
            updateTask(task.id, {
              status: "expired",
              expiredAt: new Date().toISOString()
            });
            continue;
          }

          const matched = matchesExpected(task.expected || [], response);
          if (!matched) {
            continue;
          }

          const context = {
            taskId: task.id,
            to: task.to,
            response: {
              key: response.key,
              text: response.text,
              replyToMessageId: response.replyToMessageId || null
            },
            selected: matched
          };

          if (task.status === "pending") {
            updateTask(task.id, {
              status: "attending",
              attendingAt: new Date().toISOString()
            });
          }

          let actionResult = null;
          if (matched.action) {
            try {
              actionResult = await runAction({
                bailey,
                action: matched.action,
                context,
                onCreateTask: createTaskFromSend
              });
            } catch (error) {
              actionResult = {
                ok: false,
                error: error?.message || "ACTION_EXECUTION_FAILED"
              };
            }
          }

          logTaskDebug(
            `task=${task.id} status=${task.status} matched=${matched.key || matched.aliases?.[0] || "alias"} action=${matched.action ? "yes" : "no"}`
          );

          if (task.status === "persistent") {
            cancelOtherTemporaryTasks({
              to: task.to,
              reason: "persistent_command_triggered"
            });

            updateTask(task.id, {
              status: "persistent",
              selected: {
                key: matched.key,
                aliases: matched.aliases
              },
              response,
              actionResult,
              lastTriggeredAt: new Date().toISOString(),
              triggerCount: (Number(task.triggerCount) || 0) + 1
            });
            break;
          }

          updateTask(task.id, {
            status: "completed",
            completedAt: new Date().toISOString(),
            selected: {
              key: matched.key,
              aliases: matched.aliases
            },
            response,
            actionResult,
            lastTriggeredAt: new Date().toISOString(),
            triggerCount: (Number(task.triggerCount) || 0) + 1
          });

          break;
        }
      } catch {
        // do not let parse/action errors crash the process
      }
    }
  };

  return {
    start() {
      if (started) return;
      started = true;
      bailey.on("messages.upsert", onMessagesUpsert);
      void runMaintenanceLoop().catch((error) => {
        console.error("[taskService] startup loop error:", error?.message || error);
      });
      interval = setInterval(() => {
        void runMaintenanceLoop().catch((error) => {
          console.error("[taskService] loop error:", error?.message || error);
        });
      }, 1000);
    },

    stop() {
      if (!started) return;
      started = false;
      bailey.off("messages.upsert", onMessagesUpsert);
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },

    createFromSend({ requestBody, sendResult }) {
      return createTaskFromSend({ requestBody, sendResult });
    },

    createPersistentCommand({ to, expected, action, notes = null }) {
      const normalizedTo = normalizeJid(to);
      const items = normalizeExpected(Array.isArray(expected) ? expected : []);
      if (!items.length) {
        throw new Error("PERSISTENT_EXPECTED_REQUIRED");
      }

      const createdAtMs = nowMs();
      const task = {
        id: randomUUID(),
        status: "persistent",
        to: normalizedTo,
        scope: inferScopeFromJid(normalizedTo),
        requestBodyType: "persistent_command",
        sentMessageId: null,
        expected: items,
        onTimeout: null,
        createdAt: new Date(createdAtMs).toISOString(),
        createdAtMs,
        expiresAt: null,
        expiresAtMs: null,
        timeoutMs: null,
        updatedAt: new Date(createdAtMs).toISOString(),
        notes: notes ? String(notes) : null,
        triggerCount: 0,
        lastTriggeredAt: null
      };

      return saveTask(task);
    },

    list({ status, to } = {}) {
      const normalizedTo = to ? normalizeJid(String(to)) : null;
      return getAllTasks().filter((task) => {
        if (status && task.status !== status) return false;
        if (normalizedTo && task.to !== normalizedTo) return false;
        return true;
      });
    },

    stats() {
      const tasks = getAllTasks();
      const byStatus = tasks.reduce((acc, task) => {
        const key = task.status || "unknown";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});

      return {
        total: tasks.length,
        byStatus
      };
    },

    get(taskId) {
      return getTaskById(taskId);
    },

    cancel(taskId) {
      const task = getTaskById(taskId);
      if (!task) return null;
      if (task.status === "persistent") {
        const updatedPersistent = updateTask(taskId, {
          status: "cancelled",
          cancelledAt: new Date().toISOString()
        });
        return updatedPersistent;
      }

      const updated = updateTask(taskId, {
        status: "cancelled",
        cancelledAt: new Date().toISOString()
      });
      return updated;
    },

    remove(taskId) {
      return removeTask(taskId);
    }
  };
}
