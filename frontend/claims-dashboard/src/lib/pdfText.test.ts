import { describe, expect, it, vi } from "vitest";

// Run the real pdf.js in Node: its legacy build works without a browser, and the web worker setting
// (a URL that only makes sense in the browser) is swallowed.
vi.mock("pdfjs-dist", async () => {
  const legacy = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return { ...legacy, GlobalWorkerOptions: {} };
});

import { linesFromItems, readPdfText } from "./pdfText";
import { readDocument } from "./readDocument";

/** Builds a real multi-page PDF whose pages each hold numbered clauses, one line per clause. */
function buildPdf(pageCount: number, linesPerPage = 6): Uint8Array {
  const objects: string[] = [];
  const kids: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  for (let p = 0; p < pageCount; p += 1) {
    const pageObj = 4 + p * 2;
    const contentObj = pageObj + 1;
    kids.push(`${pageObj} 0 R`);
    const stream = Array.from({ length: linesPerPage }, (_, l) =>
      `BT /F1 11 Tf 50 ${760 - l * 24} Td (${p + 1}.${l + 1} Clause ${p + 1}.${l + 1}: the insured shall bear ${p + l}% of the claim.) Tj ET`,
    ).join("\n");
    objects[pageObj] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObj} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objects[contentObj] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pageCount} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i += 1) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i += 1) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

const pdfFile = (pages: number, name = "policy.pdf") => new File([buildPdf(pages) as BlobPart], name, { type: "application/pdf" });

describe("reading a long PDF", () => {
  it("reads all 63 pages, not just the first 8, with nothing cut off", async () => {
    const seen: number[] = [];
    const read = await readPdfText(pdfFile(63), (page) => seen.push(page));
    expect(read.pages).toBe(63);
    expect(read.method).toBe("pdf-text");
    expect(seen).toHaveLength(63);
    for (const n of [1, 8, 9, 30, 62, 63]) {
      expect(read.text).toContain(`--- Page ${n} ---`);
      expect(read.text).toContain(`Clause ${n}.6`); // the last line of each page
    }
    // The old reader cut the text at 8,000 characters; this document is nearly three times that.
    expect(read.text.length).toBeGreaterThan(8000 * 2);
    expect(read.text.trim().endsWith("of the claim.")).toBe(true);
  });

  it("keeps one clause per line, so the policy chunker can find clause numbers", async () => {
    const { text } = await readPdfText(pdfFile(2));
    const page1 = text.split("--- Page 2 ---")[0];
    const clauseLines = page1.split("\n").filter((l) => /^1\.\d /.test(l));
    expect(clauseLines).toHaveLength(6);
    expect(clauseLines[0]).toBe("1.1 Clause 1.1: the insured shall bear 0% of the claim.");
  });

  it("goes through readDocument with the page count and no warning", async () => {
    const read = await readDocument(pdfFile(63, "icici-lombard.pdf"));
    expect(read.pages).toBe(63);
    expect(read.warning).toBeUndefined();
    expect(read.text).toContain("--- Page 63 ---");
  });

  it("reads a long text file in full", async () => {
    const body = Array.from({ length: 4000 }, (_, i) => `${i + 1}.1 Clause ${i + 1}: some policy wording that matters.`).join("\n");
    const read = await readDocument(new File([body], "policy.txt"));
    expect(read.text).toBe(body);
    expect(read.text.length).toBeGreaterThan(100_000);
  });

  it("rejects an empty document and unsupported files with a clear message", async () => {
    await expect(readDocument(new File(["   "], "blank.txt"))).rejects.toThrow(/No readable text/);
    await expect(readDocument(new File(["x"], "policy.docx"))).rejects.toThrow(/Unsupported file type/);
  });
});

describe("rebuilding lines from pdf.js fragments", () => {
  const item = (str: string, x: number, y: number, width = str.length * 5, hasEOL = false) => ({ str, transform: [1, 0, 0, 1, x, y], width, hasEOL });

  it("starts a new line when the vertical position moves", () => {
    expect(linesFromItems([item("1.1 Deductible", 50, 700), item("Rs. 7,500", 50, 680)])).toEqual(["1.1 Deductible", "Rs. 7,500"]);
  });

  it("keeps fragments on the same line together and adds a space when words are not separated", () => {
    expect(linesFromItems([item("Room", 50, 700, 20), item("rent", 75, 700, 20), item(" up", 100, 700, 15)])).toEqual(["Room rent up"]);
  });

  it("honours end-of-line markers and drops empty lines", () => {
    expect(linesFromItems([item("A", 50, 700, 5, true), item("", 50, 700), item("B", 50, 700)])).toEqual(["A", "B"]);
  });

  it("ignores marked-content entries that have no text", () => {
    expect(linesFromItems([{ transform: [1, 0, 0, 1, 0, 0] } as never, item("kept", 50, 700)])).toEqual(["kept"]);
  });
});
