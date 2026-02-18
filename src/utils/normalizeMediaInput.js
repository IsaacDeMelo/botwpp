function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseDataUrl(value) {
  const match = /^data:([^;,]+)?((?:;[^;,=]+=[^;,]+)*)(;base64)?,([\s\S]*)$/i.exec(
    value
  );
  if (!match) return null;

  const mime = (match[1] || "").trim().toLowerCase() || null;
  const isBase64 = Boolean(match[3]);
  const body = match[4] || "";

  try {
    const buffer = isBase64
      ? Buffer.from(body, "base64")
      : Buffer.from(decodeURIComponent(body), "utf-8");

    return {
      media: buffer,
      detectedMimeType: mime
    };
  } catch {
    throw new Error("INVALID_DATA_URL");
  }
}

function extractSvgMarkup(value) {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (!input) return null;

  const svgMatch = input.match(/<svg[\s\S]*?<\/svg>/i);
  if (svgMatch?.[0]) {
    return svgMatch[0];
  }

  return null;
}

function parseSvgLike(value) {
  const svg = extractSvgMarkup(value);
  if (!svg) return null;

  return {
    media: Buffer.from(svg, "utf-8"),
    detectedMimeType: "image/svg+xml",
    fromSvg: true
  };
}

export function normalizeMediaInput(input) {
  if (!input) {
    throw new Error("MEDIA_REQUIRED");
  }

  if (Buffer.isBuffer(input)) {
    return {
      media: input,
      detectedMimeType: null,
      fromSvg: false
    };
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error("MEDIA_REQUIRED");
    }

    const asDataUrl = parseDataUrl(trimmed);
    if (asDataUrl) {
      return {
        ...asDataUrl,
        fromSvg: asDataUrl.detectedMimeType === "image/svg+xml"
      };
    }

    const asSvg = parseSvgLike(trimmed);
    if (asSvg) {
      return asSvg;
    }

    return {
      media: { url: trimmed },
      detectedMimeType: null,
      fromSvg: false
    };
  }

  if (isPlainObject(input)) {
    if (typeof input.dataUrl === "string") {
      return normalizeMediaInput(input.dataUrl);
    }

    if (typeof input.url === "string") {
      return normalizeMediaInput(input.url);
    }

    if (typeof input.svgUrl === "string") {
      return normalizeMediaInput(input.svgUrl);
    }

    if (typeof input.svg_url === "string") {
      return normalizeMediaInput(input.svg_url);
    }

    if (typeof input.svg === "string") {
      return normalizeMediaInput(input.svg);
    }

    if (typeof input.svgText === "string") {
      return normalizeMediaInput(input.svgText);
    }

    if (typeof input.html === "string") {
      return normalizeMediaInput(input.html);
    }

    return {
      media: input,
      detectedMimeType: null,
      fromSvg: false
    };
  }

  return {
    media: input,
    detectedMimeType: null,
    fromSvg: false
  };
}
