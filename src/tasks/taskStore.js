import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { createClient } from "@supabase/supabase-js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "tasks.db");

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_KEY = String(process.env.SUPABASE_KEY || "").trim();
const SUPABASE_PERSISTENT_TABLE = String(
  process.env.SUPABASE_TASKS_PERSISTENT_TABLE || "response_tasks_persistent"
).trim();
const SUPABASE_PENDING_TABLE = String(
  process.env.SUPABASE_TASKS_PENDING_TABLE || "response_tasks_pending"
).trim();
const SUPABASE_EXPIRED_TABLE = String(
  process.env.SUPABASE_TASKS_EXPIRED_TABLE || "response_tasks_expired"
).trim();
const SUPABASE_COMPLETED_TABLE = String(
  process.env.SUPABASE_TASKS_COMPLETED_TABLE || "response_tasks_completed"
).trim();

const DEFAULT_SYNC_MAX_AGE_MS = 5 * 60_000;
const SYNC_MAX_AGE_MS = Number(process.env.TASKS_SYNC_MAX_AGE_MS) || DEFAULT_SYNC_MAX_AGE_MS;

const ACTIVE_STATUSES = ["pending", "attending", "persistent"];
const FINISHED_STATUSES = ["completed", "expired", "cancelled"];
const ALL_STATUSES = [...ACTIVE_STATUSES, ...FINISHED_STATUSES];

let db = null;
let initialized = false;
let initPromise = null;
let syncQueue = Promise.resolve();
let remoteSupportsTriggerFields = true;

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

const SUPABASE_TABLES = [
  SUPABASE_PERSISTENT_TABLE,
  SUPABASE_PENDING_TABLE,
  SUPABASE_EXPIRED_TABLE,
  SUPABASE_COMPLETED_TABLE
];

function tableForStatus(status) {
  if (status === "persistent") return SUPABASE_PERSISTENT_TABLE;
  if (["pending", "attending"].includes(status)) return SUPABASE_PENDING_TABLE;
  if (["completed"].includes(status)) return SUPABASE_COMPLETED_TABLE;
  return SUPABASE_EXPIRED_TABLE;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensureSchema(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      "to" TEXT,
      scope TEXT,
      requestBodyType TEXT,
      sentMessageId TEXT,
      expectedJson TEXT,
      onTimeoutJson TEXT,
      selectedJson TEXT,
      responseJson TEXT,
      actionResultJson TEXT,
      createdAt TEXT,
      createdAtMs INTEGER,
      expiresAt TEXT,
      expiresAtMs INTEGER,
      timeoutMs INTEGER,
      updatedAt TEXT,
      attendingAt TEXT,
      completedAt TEXT,
      expiredAt TEXT,
      cancelledAt TEXT,
      notes TEXT,
      triggerCount INTEGER DEFAULT 0,
      lastTriggeredAt TEXT
    );

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_to ON tasks("to");
    CREATE INDEX IF NOT EXISTS idx_tasks_created_ms ON tasks(createdAtMs DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updatedAt DESC);
  `);

  const columns = conn.prepare("PRAGMA table_info(tasks)").all();
  const names = new Set(columns.map((col) => String(col.name)));
  if (!names.has("triggerCount")) {
    conn.exec("ALTER TABLE tasks ADD COLUMN triggerCount INTEGER DEFAULT 0");
  }
  if (!names.has("lastTriggeredAt")) {
    conn.exec("ALTER TABLE tasks ADD COLUMN lastTriggeredAt TEXT");
  }
}

function ensureDb() {
  if (db) {
    return db;
  }

  ensureDataDir();

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  ensureSchema(db);
  return db;
}

function toJson(value) {
  return JSON.stringify(value ?? null);
}

function fromJson(text, fallback = null) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeTask(task) {
  const status = ALL_STATUSES.includes(task?.status) ? task.status : "pending";

  return {
    id: String(task?.id || "").trim(),
    status,
    to: task?.to ?? null,
    scope: task?.scope ?? null,
    requestBodyType: task?.requestBodyType ?? null,
    sentMessageId: task?.sentMessageId ?? null,
    expected: task?.expected ?? [],
    onTimeout: task?.onTimeout ?? null,
    selected: task?.selected ?? null,
    response: task?.response ?? null,
    actionResult: task?.actionResult ?? null,
    createdAt: task?.createdAt ?? null,
    createdAtMs: Number(task?.createdAtMs) || null,
    expiresAt: task?.expiresAt ?? null,
    expiresAtMs: Number(task?.expiresAtMs) || null,
    timeoutMs: Number.isFinite(Number(task?.timeoutMs)) ? Number(task.timeoutMs) : null,
    updatedAt: task?.updatedAt ?? new Date().toISOString(),
    attendingAt: task?.attendingAt ?? null,
    completedAt: task?.completedAt ?? null,
    expiredAt: task?.expiredAt ?? null,
    cancelledAt: task?.cancelledAt ?? null,
    notes: task?.notes ?? null,
    triggerCount: Number(task?.triggerCount) || 0,
    lastTriggeredAt: task?.lastTriggeredAt ?? null
  };
}

function rowToTask(row) {
  if (!row) return null;

  const createdAtMs = Number(row.createdAtMs) || null;
  const timeoutMs = Number.isFinite(Number(row.timeoutMs)) ? Number(row.timeoutMs) : null;

  let expiresAtMs = Number(row.expiresAtMs) || null;
  if (!expiresAtMs) {
    const parsedExpiresAt = row.expiresAt ? Date.parse(row.expiresAt) : NaN;
    if (Number.isFinite(parsedExpiresAt) && parsedExpiresAt > 0) {
      expiresAtMs = parsedExpiresAt;
    } else if (createdAtMs && timeoutMs && timeoutMs > 0) {
      expiresAtMs = createdAtMs + timeoutMs;
    } else {
      const parsedCreatedAt = row.createdAt ? Date.parse(row.createdAt) : NaN;
      if (Number.isFinite(parsedCreatedAt) && parsedCreatedAt > 0 && timeoutMs && timeoutMs > 0) {
        expiresAtMs = parsedCreatedAt + timeoutMs;
      }
    }
  }

  const expiresAt = row.expiresAt || (expiresAtMs ? new Date(expiresAtMs).toISOString() : null);

  return {
    id: row.id,
    status: row.status || "pending",
    to: row.to || null,
    scope: row.scope || null,
    requestBodyType: row.requestBodyType || null,
    sentMessageId: row.sentMessageId || null,
    expected: fromJson(row.expectedJson, []),
    onTimeout: fromJson(row.onTimeoutJson, null),
    selected: fromJson(row.selectedJson, null),
    response: fromJson(row.responseJson, null),
    actionResult: fromJson(row.actionResultJson, null),
    createdAt: row.createdAt || null,
    createdAtMs,
    expiresAt,
    expiresAtMs,
    timeoutMs,
    updatedAt: row.updatedAt || null,
    attendingAt: row.attendingAt || null,
    completedAt: row.completedAt || null,
    expiredAt: row.expiredAt || null,
    cancelledAt: row.cancelledAt || null,
    notes: row.notes || null,
    triggerCount: Number(row.triggerCount) || 0,
    lastTriggeredAt: row.lastTriggeredAt || null
  };
}

function taskToDbRow(task) {
  const normalized = normalizeTask(task);
  if (!normalized.id) {
    throw new Error("TASK_ID_REQUIRED");
  }

  return {
    id: normalized.id,
    status: normalized.status,
    to: normalized.to,
    scope: normalized.scope,
    requestBodyType: normalized.requestBodyType,
    sentMessageId: normalized.sentMessageId,
    expectedJson: toJson(normalized.expected),
    onTimeoutJson: toJson(normalized.onTimeout),
    selectedJson: toJson(normalized.selected),
    responseJson: toJson(normalized.response),
    actionResultJson: toJson(normalized.actionResult),
    createdAt: normalized.createdAt,
    createdAtMs: normalized.createdAtMs,
    expiresAt: normalized.expiresAt,
    expiresAtMs: normalized.expiresAtMs,
    timeoutMs: normalized.timeoutMs,
    updatedAt: normalized.updatedAt,
    attendingAt: normalized.attendingAt,
    completedAt: normalized.completedAt,
    expiredAt: normalized.expiredAt,
    cancelledAt: normalized.cancelledAt,
    notes: normalized.notes,
    triggerCount: normalized.triggerCount,
    lastTriggeredAt: normalized.lastTriggeredAt
  };
}

function getMetadata(key) {
  const conn = ensureDb();
  const row = conn.prepare("SELECT value FROM metadata WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setMetadata(key, value) {
  const conn = ensureDb();
  conn
    .prepare(
      `INSERT INTO metadata (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, String(value ?? ""));
}

function getLocalTaskCount() {
  const conn = ensureDb();
  const row = conn.prepare("SELECT COUNT(*) AS total FROM tasks").get();
  return Number(row?.total) || 0;
}

function getLocalLatestUpdatedAtMs() {
  const conn = ensureDb();
  const row = conn
    .prepare("SELECT updatedAt FROM tasks WHERE updatedAt IS NOT NULL ORDER BY updatedAt DESC LIMIT 1")
    .get();

  if (!row?.updatedAt) return 0;
  const value = Date.parse(row.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

function upsertTaskRow(conn, row) {
  conn
    .prepare(
      `INSERT INTO tasks (
        id, status, "to", scope, requestBodyType, sentMessageId,
        expectedJson, onTimeoutJson, selectedJson, responseJson, actionResultJson,
        createdAt, createdAtMs, expiresAt, expiresAtMs, timeoutMs,
        updatedAt, attendingAt, completedAt, expiredAt, cancelledAt, notes,
        triggerCount, lastTriggeredAt
      ) VALUES (
        @id, @status, @to, @scope, @requestBodyType, @sentMessageId,
        @expectedJson, @onTimeoutJson, @selectedJson, @responseJson, @actionResultJson,
        @createdAt, @createdAtMs, @expiresAt, @expiresAtMs, @timeoutMs,
        @updatedAt, @attendingAt, @completedAt, @expiredAt, @cancelledAt, @notes,
        @triggerCount, @lastTriggeredAt
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        "to" = excluded."to",
        scope = excluded.scope,
        requestBodyType = excluded.requestBodyType,
        sentMessageId = excluded.sentMessageId,
        expectedJson = excluded.expectedJson,
        onTimeoutJson = excluded.onTimeoutJson,
        selectedJson = excluded.selectedJson,
        responseJson = excluded.responseJson,
        actionResultJson = excluded.actionResultJson,
        createdAt = excluded.createdAt,
        createdAtMs = excluded.createdAtMs,
        expiresAt = excluded.expiresAt,
        expiresAtMs = excluded.expiresAtMs,
        timeoutMs = excluded.timeoutMs,
        updatedAt = excluded.updatedAt,
        attendingAt = excluded.attendingAt,
        completedAt = excluded.completedAt,
        expiredAt = excluded.expiredAt,
        cancelledAt = excluded.cancelledAt,
        notes = excluded.notes,
        triggerCount = excluded.triggerCount,
        lastTriggeredAt = excluded.lastTriggeredAt`
    )
    .run(row);
}

function taskToRemotePayload(task, includeTriggerFields = true) {
  const t = normalizeTask(task);

  const base = {
    id: t.id,
    status: t.status,
    to: t.to,
    scope: t.scope,
    requestBodyType: t.requestBodyType,
    sentMessageId: t.sentMessageId,
    expectedJson: toJson(t.expected),
    onTimeoutJson: toJson(t.onTimeout),
    selectedJson: toJson(t.selected),
    responseJson: toJson(t.response),
    actionResultJson: toJson(t.actionResult),
    createdAt: t.createdAt,
    createdAtMs: t.createdAtMs,
    expiresAt: t.expiresAt,
    expiresAtMs: t.expiresAtMs,
    timeoutMs: t.timeoutMs,
    updatedAt: t.updatedAt,
    attendingAt: t.attendingAt,
    completedAt: t.completedAt,
    expiredAt: t.expiredAt,
    cancelledAt: t.cancelledAt,
    notes: t.notes
  };

  if (includeTriggerFields) {
    base.triggerCount = t.triggerCount;
    base.lastTriggeredAt = t.lastTriggeredAt;
  }

  return base;
}

function remotePayloadToTask(payload) {
  return rowToTask(payload);
}

function enqueueSync(run) {
  if (!supabase) return;

  syncQueue = syncQueue
    .then(() => run())
    .catch((error) => {
      console.error("[taskStore] Supabase sync error:", error?.message || error);
    });
}

function syncUpsertTask(task) {
  if (!supabase) return;

  enqueueSync(async () => {
    const targetTable = tableForStatus(task?.status);
    const payload = taskToRemotePayload(task, remoteSupportsTriggerFields);
    const first = await supabase
      .from(targetTable)
      .upsert(payload, { onConflict: "id" });

    if (!first.error) {
      return;
    }

    const errText = String(first.error?.message || "").toLowerCase();
    const schemaMissingTriggerFields =
      errText.includes("triggercount") || errText.includes("lasttriggeredat");

    if (remoteSupportsTriggerFields && schemaMissingTriggerFields) {
      remoteSupportsTriggerFields = false;
      const legacyPayload = taskToRemotePayload(task, false);
      const second = await supabase
        .from(targetTable)
        .upsert(legacyPayload, { onConflict: "id" });

      if (second.error) {
        throw second.error;
      }
      return;
    }

    throw first.error;
  });

  enqueueSync(async () => {
    const targetTable = tableForStatus(task?.status);
    for (const tableName of SUPABASE_TABLES) {
      if (tableName === targetTable) continue;
      const { error } = await supabase
        .from(tableName)
        .delete()
        .eq("id", task.id);

      if (error) {
        throw error;
      }
    }
  });
}

function syncDeleteTask(taskId) {
  if (!supabase) return;

  enqueueSync(async () => {
    for (const tableName of SUPABASE_TABLES) {
      const { error } = await supabase
        .from(tableName)
        .delete()
        .eq("id", taskId);

      if (error) {
        throw error;
      }
    }
  });
}

async function fetchRemoteLatestUpdatedAtMs() {
  if (!supabase) return 0;

  let latest = 0;
  for (const tableName of [SUPABASE_PENDING_TABLE, SUPABASE_PERSISTENT_TABLE]) {
    const { data, error } = await supabase
      .from(tableName)
      .select("updatedAt")
      .order("updatedAt", { ascending: false })
      .limit(1);

    if (error) {
      throw error;
    }

    const value = data?.[0]?.updatedAt;
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > latest) {
      latest = parsed;
    }
  }

  return latest;
}

async function fetchRemoteActiveTasks() {
  if (!supabase) return [];

  let merged = [];
  for (const tableName of [SUPABASE_PENDING_TABLE, SUPABASE_PERSISTENT_TABLE]) {
    const { data, error } = await supabase
      .from(tableName)
      .select("*")
      .order("createdAtMs", { ascending: false });

    if (error) {
      throw error;
    }

    if (Array.isArray(data)) {
      merged = merged.concat(data);
    }
  }

  return merged
    .map(remotePayloadToTask)
    .filter((task) => task?.id && ACTIVE_STATUSES.includes(task.status))
    .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
}

function replaceLocalActiveTasks(tasks) {
  const conn = ensureDb();

  const transaction = conn.transaction((items) => {
    conn
      .prepare("DELETE FROM tasks WHERE status IN ('pending', 'attending', 'persistent')")
      .run();

    for (const task of items) {
      const row = taskToDbRow(task);
      upsertTaskRow(conn, row);
    }
  });

  transaction(tasks);
}

async function maybePullFromRemoteOnInit() {
  if (!supabase) {
    console.log("[taskStore] Supabase not configured. Running local tasks.db only.");
    return;
  }

  const now = Date.now();
  const localCount = getLocalTaskCount();
  const lastSyncMs = Number(getMetadata("lastRemotePullAtMs") || 0);
  const localLatestUpdatedAtMs = getLocalLatestUpdatedAtMs();

  let remoteLatestUpdatedAtMs = 0;
  try {
    remoteLatestUpdatedAtMs = await fetchRemoteLatestUpdatedAtMs();
  } catch (error) {
    console.error("[taskStore] Failed to check remote version:", error?.message || error);
    return;
  }

  const isTooOld = !lastSyncMs || now - lastSyncMs >= SYNC_MAX_AGE_MS;
  const remoteIsNewer = remoteLatestUpdatedAtMs > localLatestUpdatedAtMs;
  const shouldPull = localCount === 0 || isTooOld || remoteIsNewer;

  if (!shouldPull) {
    return;
  }

  try {
    const remoteTasks = await fetchRemoteActiveTasks();
    replaceLocalActiveTasks(remoteTasks);
    setMetadata("lastRemotePullAtMs", String(now));

    console.log(
      `[taskStore] Initial pull completed (${remoteTasks.length} active tasks loaded from Supabase).`
    );
  } catch (error) {
    console.error("[taskStore] Initial pull failed:", error?.message || error);
  }
}

export async function initTaskStore() {
  if (initialized) return;
  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    ensureDb();
    await maybePullFromRemoteOnInit();
    initialized = true;
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

export function getAllTasks() {
  ensureDb();

  const rows = db
    .prepare("SELECT * FROM tasks ORDER BY createdAtMs DESC")
    .all();

  return rows.map(rowToTask);
}

export function getTaskById(taskId) {
  ensureDb();

  const row = db
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(taskId);

  return rowToTask(row);
}

export function saveTask(task) {
  ensureDb();

  const row = taskToDbRow(task);
  upsertTaskRow(db, row);

  const saved = rowToTask(row);
  syncUpsertTask(saved);
  return saved;
}

export function removeTask(taskId) {
  ensureDb();

  const result = db
    .prepare("DELETE FROM tasks WHERE id = ?")
    .run(taskId);

  if (result.changes > 0) {
    syncDeleteTask(taskId);
    return true;
  }

  return false;
}

export function updateTask(taskId, patch) {
  const found = getTaskById(taskId);
  if (!found) {
    return null;
  }

  const merged = {
    ...found,
    ...patch,
    updatedAt: new Date().toISOString()
  };

  return saveTask(merged);
}
