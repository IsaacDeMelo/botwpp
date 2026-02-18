function hasSvgMarkup(value) {
  return /<svg[\s\S]*?<\/svg>/i.test(value);
}

function isLikelySvgUrl(url) {
  if (typeof url !== "string") return false;

  try {
    const parsed = new URL(url);
    return parsed.pathname.toLowerCase().endsWith(".svg");
  } catch {
    return false;
  }
}

async function loadSvgTextFromUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`SVG_URL_FETCH_FAILED_${response.status}`);
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const text = await response.text();
  const bodyLooksLikeSvg = hasSvgMarkup(text);

  if (!contentType.includes("image/svg+xml") && !bodyLooksLikeSvg) {
    throw new Error("SVG_URL_NOT_SVG_CONTENT");
  }

  return text;
}

async function convertSvgTextToPngBuffer(svgText) {
  let sharpModule;

  try {
    sharpModule = await import("sharp");
  } catch {
    throw new Error("SVG_TO_PNG_DEPENDENCY_MISSING_SHARP");
  }

  const sharp = sharpModule.default || sharpModule;
  return sharp(Buffer.from(svgText, "utf-8")).png().toBuffer();
}

export async function normalizeSvgImageToPng(input, normalizedMedia) {
  const normalized = normalizedMedia || {};
  const media = normalized.media;
  const svgTextCandidates = [];

  if (normalized.fromSvg && Buffer.isBuffer(media)) {
    svgTextCandidates.push(media.toString("utf-8"));
  }

  if (typeof input === "string" && hasSvgMarkup(input)) {
    svgTextCandidates.push(input);
  }

  if (input && typeof input === "object" && typeof input.svg === "string") {
    svgTextCandidates.push(input.svg);
  }

  if (svgTextCandidates.length > 0) {
    const pngBuffer = await convertSvgTextToPngBuffer(svgTextCandidates[0]);
    return {
      media: pngBuffer,
      mimetype: "image/png",
      convertedFromSvg: true
    };
  }

  const rawUrl =
    typeof input === "string"
      ? input
      : input && typeof input === "object" && typeof input.url === "string"
      ? input.url
      : null;

  if (rawUrl && isLikelySvgUrl(rawUrl)) {
    const svgText = await loadSvgTextFromUrl(rawUrl);
    const pngBuffer = await convertSvgTextToPngBuffer(svgText);
    return {
      media: pngBuffer,
      mimetype: "image/png",
      convertedFromSvg: true
    };
  }

  return null;
}
