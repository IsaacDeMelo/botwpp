import test from "node:test";
import assert from "node:assert/strict";
import { normalizeJid } from "../src/utils/normalizeJid.js";

test("accepts new group jid without hyphen", () => {
  assert.equal(
    normalizeJid("120363421971166966@g.us"),
    "120363421971166966@g.us"
  );
});

test("accepts legacy group jid with hyphen", () => {
  assert.equal(
    normalizeJid("558288668478-1585151222@g.us"),
    "558288668478-1585151222@g.us"
  );
});

test("normalizes plain user number", () => {
  assert.equal(normalizeJid("5511999999999"), "5511999999999@s.whatsapp.net");
});

test("accepts status broadcast jid", () => {
  assert.equal(normalizeJid("status@broadcast"), "status@broadcast");
});

test("rejects invalid group alpha local part", () => {
  assert.throws(() => normalizeJid("abc@g.us"), {
    message: "TO_INVALID_JID"
  });
});

test("rejects malformed group with double hyphen", () => {
  assert.throws(() => normalizeJid("12345--678@g.us"), {
    message: "TO_INVALID_JID"
  });
});
