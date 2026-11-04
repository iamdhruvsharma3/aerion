import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { createCanvas } from "@napi-rs/canvas";
import { documentPages } from "./documents";
function pdfFixture() {
  const content = "BT /F1 12 Tf 50 740 Td (Manufacturer: Airbus) Tj 0 -20 Td (Model: A319) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(text);
}
describe("document ingestion", () => {
  it("extracts text from a real PDF and preserves page references", async () => {
    const pages = await documentPages(pdfFixture(), "pdf");
    expect(pages).toHaveLength(1);
    expect(pages[0].page).toBe(1);
    expect(pages[0].text).toContain("Manufacturer: Airbus");
    expect(pages[0].text).toContain("Model: A319");
  });
  it("locally transcribes an image-only PDF with page and OCR provenance", async () => {
    const canvas = createCanvas(1200, 400),
      ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 1200, 400);
    ctx.fillStyle = "black";
    ctx.font = "36px Arial";
    ctx.fillText("Manufacturer: Airbus", 60, 100);
    ctx.fillText("Model: A319", 60, 180);
    const rgba = ctx.getImageData(0, 0, 1200, 400).data;
    const rgb = Buffer.alloc(1200 * 400 * 3);
    for (let i = 0; i < 1200 * 400; i++) {
      rgb[i * 3] = rgba[i * 4];
      rgb[i * 3 + 1] = rgba[i * 4 + 1];
      rgb[i * 3 + 2] = rgba[i * 4 + 2];
    }
    const image = deflateSync(rgb);
    const content = "q 600 0 0 200 0 0 cm /Im0 Do Q";
    const parts = [
      Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
      Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
      Buffer.from(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
      ),
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width 1200 /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`,
        ),
        image,
        Buffer.from("\nendstream"),
      ]),
      Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    ];
    const chunks = [Buffer.from("%PDF-1.4\n")],
      offsets = [0];
    for (const [i, object] of parts.entries()) {
      offsets.push(Buffer.concat(chunks).length);
      chunks.push(Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from("\nendobj\n"));
    }
    const xref = Buffer.concat(chunks).length;
    chunks.push(
      Buffer.from(
        `xref\n0 6\n0000000000 65535 f \n${offsets
          .slice(1)
          .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
          .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
      ),
    );
    const pages = await documentPages(Buffer.concat(chunks), "pdf");
    expect(pages[0].page).toBe(1);
    expect(pages[0].text).toContain("OCR transcription");
    expect(pages[0].text).toContain("Manufacturer: Airbus");
    expect(pages[0].text).toContain("Model: A319");
  }, 30000);
  it("rejects oversized and empty documents", async () => {
    await expect(documentPages(Buffer.alloc(10_000_001), "text")).rejects.toMatchObject({
      status: 413,
    });
    await expect(documentPages(Buffer.from("  "), "text")).rejects.toMatchObject({ status: 422 });
  });
});
