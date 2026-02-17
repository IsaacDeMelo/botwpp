import { normalizeJid } from "./normalizeJid.js";

const MENTION_REGEX = /@\{(\d+)\}/g;

export function parseMentions(text = "") {
  const mentions = [];
  const parsedText = text.replace(MENTION_REGEX, (_, number) => {
    const jid = normalizeJid(number);
    mentions.push(jid);
    return `@${number}`;
  });

  return {
    text: parsedText,
    mentions
  };
}
