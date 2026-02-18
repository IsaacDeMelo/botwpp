import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMediaInput } from "../src/utils/normalizeMediaInput.js";

test("normalizes image data URL into Buffer", () => {
  const input = "data:image/png;base64,aGVsbG8=";
  const normalized = normalizeMediaInput(input);

  assert.equal(Buffer.isBuffer(normalized.media), true);
  assert.equal(normalized.media.toString("utf-8"), "hello");
  assert.equal(normalized.detectedMimeType, "image/png");
  assert.equal(normalized.fromSvg, false);
});

test("normalizes svg from html wrapper", () => {
  const input =
    "<html><body><svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"10\" height=\"10\"/></svg></body></html>";
  const normalized = normalizeMediaInput({ html: input });

  assert.equal(Buffer.isBuffer(normalized.media), true);
  assert.match(normalized.media.toString("utf-8"), /<svg[\s\S]*<\/svg>/i);
  assert.equal(normalized.detectedMimeType, "image/svg+xml");
  assert.equal(normalized.fromSvg, true);
});

test("keeps http URL as media url object", () => {
  const normalized = normalizeMediaInput({
    url: "https://example.com/image.png"
  });

  assert.deepEqual(normalized.media, { url: "https://example.com/image.png" });
  assert.equal(normalized.detectedMimeType, null);
  assert.equal(normalized.fromSvg, false);
});

test("supports svgUrl key as URL source", () => {
  const normalized = normalizeMediaInput({
    svgUrl: "https://example.com/banner.svg"
  });

  assert.deepEqual(normalized.media, { url: "https://example.com/banner.svg" });
  assert.equal(normalized.detectedMimeType, null);
  assert.equal(normalized.fromSvg, false);
});

test("supports svg_url key as URL source", () => {
  const normalized = normalizeMediaInput({
    svg_url: "https://example.com/banner.svg"
  });

  assert.deepEqual(normalized.media, { url: "https://example.com/banner.svg" });
  assert.equal(normalized.detectedMimeType, null);
  assert.equal(normalized.fromSvg, false);
});
