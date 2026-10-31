import type { DetectionPayload, SourceFormat } from "../types";
import {
  detectFormat,
  payloadFromCsv,
  payloadFromObject,
  payloadFromText,
  payloadFromWorkbook,
} from "./ingest";

async function extractPdf(file: File): Promise<DetectionPayload> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  const max = Math.min(doc.numPages, 8);
  for (let i = 1; i <= max; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    pages.push(text);
  }
  const joined = pages.join("\n");
  if (joined.replace(/\s/g, "").length > 40) {
    return payloadFromText(joined, "pdf", "pdf-text-engine", file.name, false);
  }

  const ocrChunks: string[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, 3); i += 1) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1.6 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    await page.render({ canvas, viewport, canvasContext: ctx }).promise;
    ocrChunks.push(await ocrSource(canvas));
  }
  return payloadFromText(
    ocrChunks.join("\n"),
    "pdf",
    "pdf-ocr-engine",
    file.name,
    true,
  );
}

export async function ocrSource(image: File | HTMLCanvasElement) {
  const tesseract = await import("tesseract.js");
  const recognize =
    tesseract.recognize ??
    (tesseract as { default?: { recognize: typeof tesseract.recognize } })
      .default?.recognize;
  if (!recognize) throw new Error("OCR engine failed to load");
  const { data } = await recognize(image, "eng");
  return data.text || "";
}

async function extractImage(file: File): Promise<DetectionPayload> {
  const text = await ocrSource(file);
  return payloadFromText(text, "image", "tesseract-ocr", file.name, true);
}

export async function extractFromFile(file: File): Promise<DetectionPayload> {
  if (file.name.toLowerCase().endsWith(".xls")) {
    throw new Error(
      "Legacy .xls files are not supported. Save the workbook as .xlsx and upload it again.",
    );
  }
  const format = detectFormat(file);
  if (file.size > 12 * 1024 * 1024) {
    throw new Error(
      "File is larger than 12 MB. Split the pack or upload a smaller extract.",
    );
  }
  if (format === "json") {
    const text = await file.text();
    return payloadFromObject(JSON.parse(text), "json", file.name);
  }
  if (format === "csv" || format === "text") {
    const text = await file.text();
    if (format === "csv" || file.name.toLowerCase().endsWith(".csv"))
      return payloadFromCsv(text, file.name);
    return payloadFromText(text, "text", "plain-text-parser", file.name);
  }
  if (format === "xlsx") {
    return payloadFromWorkbook(await file.arrayBuffer(), file.name);
  }
  if (format === "pdf") return extractPdf(file);
  if (format === "image") return extractImage(file);
  return payloadFromText(
    await file.text(),
    "text",
    "fallback-parser",
    file.name,
  );
}

export async function extractFromUrl(url: string): Promise<DetectionPayload> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("That does not look like a valid URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https links are accepted.");
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Link returned ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
      return payloadFromObject(await res.json(), "url", url);
    }
    if (contentType.includes("csv") || url.endsWith(".csv")) {
      return payloadFromCsv(await res.text(), url, "url");
    }
    const text = await res.text();
    const stripped = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ");
    const payload = payloadFromText(stripped, "url", "web-extractor", url);
    payload.source.url = url;
    payload.source.warnings.push(
      "Web extraction depends on public HTML. If the page is gated, paste JSON instead.",
    );
    return payload;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not fetch URL";
    const payload = payloadFromText(
      `URL ${url}\n${message}`,
      "url",
      "web-extractor",
      url,
    );
    payload.source.url = url;
    payload.source.warnings = [
      "The browser could not read this link (often CORS). Paste the page JSON/CSV or upload a file instead.",
      message,
    ];
    payload.extraction.valid = false;
    payload.extraction.missingFields = ["remote document"];
    return payload;
  }
}

export function formatLabel(format: SourceFormat) {
  return {
    json: "JSON parser",
    csv: "CSV parser",
    xlsx: "Excel parser",
    pdf: "PDF text / OCR",
    image: "Tesseract OCR",
    url: "Web extractor",
    text: "Text parser",
  }[format];
}
