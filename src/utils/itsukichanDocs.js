import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOCS_PATH = path.resolve(__dirname, "../../ITSUKICHAN.md");

function slugifyHeading(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function readDocs() {
  if (!fs.existsSync(DOCS_PATH)) {
    throw new Error("ITSUKICHAN_DOC_NOT_FOUND");
  }

  return fs.readFileSync(DOCS_PATH, "utf-8");
}

function parseHeadings(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headings = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;

    const level = match[1].length;
    const title = match[2].trim();
    headings.push({
      title,
      level,
      line: i + 1,
      anchor: slugifyHeading(title)
    });
  }

  return { headings, lines };
}

function getSectionBody(lines, headings, index) {
  const current = headings[index];
  if (!current) return "";

  const start = current.line;
  let end = lines.length;

  for (let i = index + 1; i < headings.length; i += 1) {
    if (headings[i].level <= current.level) {
      end = headings[i].line - 1;
      break;
    }
  }

  return lines.slice(start, end).join("\n").trim();
}

export function getDocsIndex({ q = "", level } = {}) {
  const markdown = readDocs();
  const { headings } = parseHeadings(markdown);
  const query = String(q || "").trim().toLowerCase();
  const levelNumber = Number(level);

  return headings.filter((item) => {
    if (Number.isInteger(levelNumber) && levelNumber > 0 && item.level !== levelNumber) {
      return false;
    }

    if (!query) return true;

    return (
      item.title.toLowerCase().includes(query) ||
      item.anchor.includes(query)
    );
  });
}

export function getDocsSection({ title, anchor }) {
  const markdown = readDocs();
  const { headings, lines } = parseHeadings(markdown);
  const titleQuery = String(title || "").trim().toLowerCase();
  const anchorQuery = String(anchor || "").trim().toLowerCase().replace(/^#/, "");

  if (!titleQuery && !anchorQuery) {
    throw new Error("DOCS_TITLE_OR_ANCHOR_REQUIRED");
  }

  let index = -1;

  if (anchorQuery) {
    index = headings.findIndex((h) => h.anchor === anchorQuery);
  }

  if (index < 0 && titleQuery) {
    index = headings.findIndex((h) => h.title.toLowerCase() === titleQuery);
  }

  if (index < 0 && titleQuery) {
    index = headings.findIndex((h) => h.title.toLowerCase().includes(titleQuery));
  }

  if (index < 0) {
    return null;
  }

  const heading = headings[index];
  return {
    ...heading,
    content: getSectionBody(lines, headings, index)
  };
}

function makeSnippet(content, query, maxLen = 280) {
  const compact = String(content || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (!query) return compact.slice(0, maxLen);

  const idx = compact.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return compact.slice(0, maxLen);

  const start = Math.max(0, idx - 90);
  const end = Math.min(compact.length, idx + 190);
  return compact.slice(start, end);
}

function scoreMatch(item, query) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const title = item.title.toLowerCase();
  const anchor = item.anchor.toLowerCase();
  const content = item.content.toLowerCase();

  let score = 0;
  if (title === q) score += 120;
  if (anchor === q) score += 110;
  if (title.includes(q)) score += 70;
  if (anchor.includes(q)) score += 60;
  if (content.includes(q)) score += 30;
  if (title.startsWith(q)) score += 20;

  return score;
}

export function searchDocs({
  q = "",
  limit = 10,
  level
} = {}) {
  const query = String(q || "").trim();
  if (!query) {
    throw new Error("DOCS_QUERY_REQUIRED");
  }

  const markdown = readDocs();
  const { headings, lines } = parseHeadings(markdown);
  const levelNumber = Number(level);
  const parsedLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);

  const pool = headings
    .map((h, originalIndex) => ({ ...h, originalIndex }))
    .filter((h) => {
      if (Number.isInteger(levelNumber) && levelNumber > 0 && h.level !== levelNumber) {
        return false;
      }
      return true;
    })
    .map((heading) => {
      const content = getSectionBody(lines, headings, heading.originalIndex);
      const score = scoreMatch({ ...heading, content }, query);
      return {
        title: heading.title,
        level: heading.level,
        line: heading.line,
        anchor: heading.anchor,
        score,
        snippet: makeSnippet(content, query)
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.level - b.level || a.line - b.line)
    .slice(0, parsedLimit);

  return pool;
}
