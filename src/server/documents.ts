import { transcribePages } from "./ocr";
import { HttpError } from "./http";
import type { SourcePage } from "../lib/intelligence/schema";

export async function documentPages(
  bytes: Buffer,
  kind: "pdf" | "csv" | "text",
): Promise<SourcePage[]> {
  if (bytes.length > 10_000_000) throw new HttpError(413, "Choose a document smaller than 10 MB.");
  if (kind !== "pdf") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new HttpError(422, "Use a UTF-8 text or CSV document.");
    }
    if (!text.trim() || text.includes("\0"))
      throw new HttpError(422, "Provide a non-empty UTF-8 text or CSV document.");
    if (text.length > 200_000)
      throw new HttpError(413, "Text and CSV documents support up to 200,000 characters.");
    return [{ page: 1, text }];
  }
  if (bytes.subarray(0, 5).toString() !== "%PDF-")
    throw new HttpError(422, "The file is not a PDF document.");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    disableFontFace: true,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 40) throw new HttpError(422, "Use a PDF with at most 40 pages.");
    const pages: SourcePage[] = [];
    let length = 0;
    for (let page = 1; page <= pdf.numPages; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : ""))
        .join("");
      length += text.length;
      if (length > 200_000)
        throw new HttpError(413, "PDF text exceeds 200,000 characters. Split the document.");
      pages.push({ page, text });
    }
    const unreadable = pages.filter((p) => !p.text.trim()).map((p) => p.page);
    if (unreadable.length) {
      const transcribed = await transcribePages(pdf, unreadable);
      for (const page of transcribed) pages[page.page - 1] = page;
      if (pages.reduce((total, page) => total + page.text.length, 0) > 200_000)
        throw new HttpError(413, "OCR text exceeds 200,000 characters. Split the document.");
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
