import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { ocrSource } from "./extract";

/** A text fragment as pdf.js reports it. Only the fields used here. */
export type PdfTextItem = {
  str?: string;
  /** PDF transform matrix; [4] is x and [5] is y on the page. */
  transform?: number[];
  width?: number;
  hasEOL?: boolean;
};

/**
 * Rebuilds the lines of one page. pdf.js hands back loose fragments; joining them with spaces turns a
 * whole page into a single line, which hides the numbered clauses the policy chunker looks for. A new
 * line starts when the fragment's y position moves, or when pdf.js marks an end of line.
 */
export function linesFromItems(items: PdfTextItem[]): string[] {
  const lines: string[] = [];
  let line = "";
  let lastY: number | null = null;
  let lastEnd: number | null = null;
  const flush = () => {
    if (line.trim()) lines.push(line.replace(/\s+/g, " ").trim());
    line = "";
    lastY = null;
    lastEnd = null;
  };
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const x = item.transform?.[4];
    const y = item.transform?.[5];
    if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2.5) flush();
    // Fragments on one line sometimes carry no space between words; add one when there is a visible gap.
    if (line && x !== undefined && lastEnd !== null && x - lastEnd > 1 && !line.endsWith(" ") && !item.str.startsWith(" ")) {
      line += " ";
    }
    line += item.str;
    if (y !== undefined) lastY = y;
    lastEnd = x !== undefined && item.width !== undefined ? x + item.width : null;
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

export type PdfRead = {
  text: string;
  pages: number;
  method: "pdf-text" | "pdf-ocr";
  /** Pages that were OCR'd, when the PDF had no text layer and was too long to OCR in full. */
  ocrPages?: number;
};

/** Scanned PDFs have no text layer, so each page is OCR'd in the browser; that is slow, so it is capped. */
export const MAX_OCR_PAGES = 40;

/**
 * Reads the full text of a PDF, every page, with line breaks and `--- Page N ---` markers so that clauses
 * can be cited by page. Falls back to OCR when the PDF has no text layer.
 */
export async function readPdfText(
  file: File,
  onProgress?: (page: number, total: number, stage: "text" | "ocr") => void,
): Promise<PdfRead> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;

  const pages: string[] = [];
  let characters = 0;
  for (let i = 1; i <= doc.numPages; i += 1) {
    onProgress?.(i, doc.numPages, "text");
    const content = await (await doc.getPage(i)).getTextContent();
    const body = linesFromItems(content.items as PdfTextItem[]).join("\n");
    characters += body.replace(/\s/g, "").length;
    pages.push(`--- Page ${i} ---\n${body}`);
  }
  if (characters > 40) {
    return { text: pages.join("\n\n"), pages: doc.numPages, method: "pdf-text" };
  }

  const ocrPages = Math.min(doc.numPages, MAX_OCR_PAGES);
  const chunks: string[] = [];
  for (let i = 1; i <= ocrPages; i += 1) {
    onProgress?.(i, ocrPages, "ocr");
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1.6 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    await page.render({ canvas, viewport, canvasContext: ctx }).promise;
    chunks.push(`--- Page ${i} ---\n${await ocrSource(canvas)}`);
  }
  return { text: chunks.join("\n\n"), pages: doc.numPages, method: "pdf-ocr", ocrPages };
}
