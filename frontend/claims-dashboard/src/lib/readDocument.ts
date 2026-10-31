import { ocrSource } from "./extract";
import { readPdfText } from "./pdfText";

export type DocumentRead = {
  text: string;
  /** Pages in the document, for PDFs. */
  pages?: number;
  method: "text" | "pdf-text" | "pdf-ocr" | "image-ocr";
  /** Said when the whole document could not be read, so a partial read is never silent. */
  warning?: string;
};

export type ReadProgress = (page: number, total: number, stage: "text" | "ocr") => void;

/**
 * Reads a document's full plain text. Text files are read directly; PDFs are read page by page (every
 * page); images and scanned PDFs go through OCR in the browser.
 */
export async function readDocument(file: File, onProgress?: ReadProgress): Promise<DocumentRead> {
  const name = file.name.toLowerCase();
  let read: DocumentRead;
  if (name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".csv")) {
    read = { text: await file.text(), method: "text" };
  } else if (name.endsWith(".pdf")) {
    const pdf = await readPdfText(file, onProgress);
    read = {
      text: pdf.text,
      pages: pdf.pages,
      method: pdf.method,
      warning:
        pdf.ocrPages !== undefined && pdf.ocrPages < pdf.pages
          ? `This PDF is a scan, so it was read with OCR, which is slow. Only the first ${pdf.ocrPages} of ${pdf.pages} pages were read.`
          : undefined,
    };
  } else if (/\.(png|jpe?g|webp)$/.test(name)) {
    read = { text: await ocrSource(file), method: "image-ocr" };
  } else {
    throw new Error("Unsupported file type. Upload a PDF, text file or image.");
  }
  if (read.text.replace(/\s/g, "").length < 40) {
    throw new Error("No readable text came out of that file. If it is a scan, try a clearer one.");
  }
  return read;
}

/** Same as `readDocument`, for callers that only want the text. */
export async function readDocumentText(file: File, onProgress?: ReadProgress): Promise<string> {
  return (await readDocument(file, onProgress)).text;
}
