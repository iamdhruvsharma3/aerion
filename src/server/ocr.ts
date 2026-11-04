import english from "@tesseract.js-data/eng";
import { createCanvas } from "@napi-rs/canvas";
import { createWorker, OEM, type Worker } from "tesseract.js";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import type { SourcePage } from "../lib/intelligence/schema";
import { HttpError } from "./http";

let busy = false;
/** English OCR is entirely local: packaged WASM and language data, no CDN or model requests. */
export async function transcribePages(
  pdf: PDFDocumentProxy,
  numbers: number[],
): Promise<SourcePage[]> {
  if (numbers.length > 8)
    throw new HttpError(422, "Split scanned PDFs into at most eight image-only pages per upload.");
  if (busy)
    throw new HttpError(429, "Another OCR document is processing. Retry this upload shortly.");
  busy = true;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
  const processing = async () => {
    worker = await createWorker("eng", OEM.LSTM_ONLY, {
      langPath: english.langPath,
      cacheMethod: "none",
      gzip: true,
      errorHandler: () => {},
    });
    if (expired) {
      await worker.terminate();
      throw new Error("OCR initialization timed out.");
    }
    const pages: SourcePage[] = [];
    for (const number of numbers) {
      const page = await pdf.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2.5, 2400 / base.width, 3000 / base.height);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      try {
        render = page.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          viewport,
          background: "rgb(255,255,255)",
        });
        await render.promise;
        const { data } = await worker.recognize(canvas.toBuffer("image/png"));
        if (expired) throw new Error("OCR timed out.");
        pages.push({
          page: number,
          text: `[Local English OCR transcription · original PDF page ${number} · verify characters, numbers and units against the original before approval]\n${data.text.trim() || "[No text recognized on this page]"}`,
        });
      } finally {
        canvas.width = 1;
        canvas.height = 1;
        page.cleanup();
      }
    }
    return pages;
  };
  try {
    return await Promise.race([
      processing(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          render?.cancel();
          void worker?.terminate();
          reject(
            new HttpError(
              422,
              "Local OCR exceeded 90 seconds. Split or improve the scan and retry.",
            ),
          );
        }, 90_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (worker) await worker.terminate();
    busy = false;
  }
}
