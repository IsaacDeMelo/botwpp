import fs from "fs";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const SHEETS_DIR = path.join(DATA_DIR, "task_sheets");

const STATUS_TO_SHEET = {
  pending: "open.csv",
  attending: "attending.csv",
  completed: "completed.csv",
  expired: "expired.csv",
  cancelled: "cancelled.csv"
};

const SHEETS = Object.values(STATUS_TO_SHEET);

const COLUMNS = [
  "id",
  "status",
  "to",
  "scope",
  "requestBodyType",
  "sentMessageId",
  "expectedJson",
  "onTimeoutJson",
  "selectedJson",
  "responseJson",
  "actionResultJson",
  "createdAt",
  "createdAtMs",
  "expiresAt",
  "expiresAtMs",
  "timeoutMs",
  "updatedAt",
  "attendingAt",
  "completedAt",
  "expiredAt",
  "cancelledAt",
  "notes"
];

function sheetPath(name) {
  return path.join(SHEETS_DIR, name);
}

function escapeCsv(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function parseCsvLine(line) {
  const out = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === "\"") {
      if (quoted && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === "," && !quoted) {
      out.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  out.push(current);
  return out;
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(SHEETS_DIR)) {
    fs.mkdirSync(SHEETS_DIR, { recursive: true });
  }

  const header = `${COLUMNS.join(",")}\n`;
  for (const name of SHEETS) {
    const file = sheetPath(name);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, header, "utf-8");
    }
  }
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

function statusToSheet(status) {
  return STATUS_TO_SHEET[status] || STATUS_TO_SHEET.pending;
}

function serializeTask(task) {
  return [
    task.id,
    task.status,
    task.to ?? "",
    task.scope ?? "",
    task.requestBodyType ?? "",
    task.sentMessageId ?? "",
    toJson(task.expected),
    toJson(task.onTimeout),
    toJson(task.selected),
    toJson(task.response),
    toJson(task.actionResult),
    task.createdAt ?? "",
    task.createdAtMs ?? "",
    task.expiresAt ?? "",
    task.expiresAtMs ?? "",
    task.timeoutMs ?? "",
    task.updatedAt ?? "",
    task.attendingAt ?? "",
    task.completedAt ?? "",
    task.expiredAt ?? "",
    task.cancelledAt ?? "",
    task.notes ?? ""
  ].map(escapeCsv).join(",");
}

function deserializeTask(line) {
  const cols = parseCsvLine(line);
  const map = {};
  COLUMNS.forEach((name, index) => {
    map[name] = cols[index] ?? "";
  });

  return {
    id: map.id,
    status: map.status || "pending",
    to: map.to || null,
    scope: map.scope || null,
    requestBodyType: map.requestBodyType || null,
    sentMessageId: map.sentMessageId || null,
    expected: fromJson(map.expectedJson, []),
    onTimeout: fromJson(map.onTimeoutJson, null),
    selected: fromJson(map.selectedJson, null),
    response: fromJson(map.responseJson, null),
    actionResult: fromJson(map.actionResultJson, null),
    createdAt: map.createdAt || null,
    createdAtMs: Number(map.createdAtMs) || null,
    expiresAt: map.expiresAt || null,
    expiresAtMs: Number(map.expiresAtMs) || null,
    timeoutMs: Number(map.timeoutMs) || null,
    updatedAt: map.updatedAt || null,
    attendingAt: map.attendingAt || null,
    completedAt: map.completedAt || null,
    expiredAt: map.expiredAt || null,
    cancelledAt: map.cancelledAt || null,
    notes: map.notes || null
  };
}

function readSheet(sheetName) {
  ensureStore();
  const file = sheetPath(sheetName);
  const raw = fs.readFileSync(file, "utf-8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) {
    return [];
  }

  return lines.slice(1).map(deserializeTask).filter((task) => task.id);
}

function writeSheet(sheetName, tasks) {
  ensureStore();
  const file = sheetPath(sheetName);
  const lines = [COLUMNS.join(",")];
  for (const task of tasks) {
    lines.push(serializeTask(task));
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
}

function removeTaskFromAllSheets(taskId) {
  for (const sheet of SHEETS) {
    const list = readSheet(sheet);
    const next = list.filter((task) => task.id !== taskId);
    if (next.length !== list.length) {
      writeSheet(sheet, next);
    }
  }
}

function findTaskWithSheet(taskId) {
  for (const sheet of SHEETS) {
    const list = readSheet(sheet);
    const task = list.find((item) => item.id === taskId);
    if (task) {
      return { task, sheet };
    }
  }
  return null;
}

export function getAllTasks() {
  ensureStore();
  let all = [];
  for (const sheet of SHEETS) {
    all = all.concat(readSheet(sheet));
  }
  return all.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
}

export function getTaskById(taskId) {
  const found = findTaskWithSheet(taskId);
  return found ? found.task : null;
}

export function saveTask(task) {
  ensureStore();
  const normalized = {
    ...task,
    status: task.status || "pending"
  };

  removeTaskFromAllSheets(normalized.id);
  const sheet = statusToSheet(normalized.status);
  const list = readSheet(sheet);
  list.push(normalized);
  writeSheet(sheet, list);
  return normalized;
}

export function removeTask(taskId) {
  let removed = false;
  for (const sheet of SHEETS) {
    const list = readSheet(sheet);
    const next = list.filter((task) => task.id !== taskId);
    if (next.length !== list.length) {
      removed = true;
      writeSheet(sheet, next);
    }
  }
  return removed;
}

export function updateTask(taskId, patch) {
  const found = findTaskWithSheet(taskId);
  if (!found) {
    return null;
  }

  const merged = {
    ...found.task,
    ...patch,
    updatedAt: new Date().toISOString()
  };

  removeTask(taskId);
  saveTask(merged);
  return merged;
}
