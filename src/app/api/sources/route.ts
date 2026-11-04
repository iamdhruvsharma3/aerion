import { z } from "zod";
import { requireScope } from "@/server/auth";
import { retainEmailUpload } from "@/server/communication/service";
import { documentPages } from "@/server/documents";
import { HttpError, readBounded, respond, sameOrigin } from "@/server/http";
import { createSource, readPipeline } from "@/server/repository";
export const runtime = "nodejs";
export async function GET(request: Request) {
  return respond(async () => readPipeline(await requireScope(request)));
}
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const scope = await requireScope(request);
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.startsWith("multipart/form-data;"))
      throw new HttpError(415, "Use a document upload form.");
    const bytes = await readBounded(request, 10_500_000);
    const form = await new Response(new Uint8Array(bytes), {
      headers: { "content-type": contentType },
    }).formData();
    const title = z.string().trim().min(1).max(300).parse(form.get("title"));
    const url = z
      .string()
      .trim()
      .max(2000)
      .parse(form.get("sourceUrl") ?? "");
    const sourceUrl = url ? z.url({ protocol: /^https?$/ }).parse(url) : null;
    const file = form.get("file");
    let original: Buffer, kind: "text" | "pdf" | "csv", filename: string;
    if (file instanceof File && file.size) {
      filename = file.name.slice(0, 200);
      kind = filename.toLowerCase().endsWith(".pdf")
        ? "pdf"
        : filename.toLowerCase().endsWith(".csv")
          ? "csv"
          : "text";
      if (!/\.(pdf|csv|txt|eml)$/i.test(filename))
        throw new HttpError(422, "Choose a PDF, CSV, TXT, or EML file.");
      original = Buffer.from(await file.arrayBuffer());
    } else {
      const text = z.string().min(1).max(200_000).parse(form.get("text"));
      original = Buffer.from(text, "utf8");
      kind = "text";
      filename = "source.txt";
    }
    const isEmail = filename.toLowerCase().endsWith(".eml");
    if (isEmail) {
      const result = await retainEmailUpload(scope, original, filename, { title, sourceUrl });
      return { id: result.sourceId, communicationId: result.id, issues: result.issues };
    }
    const pages = await documentPages(original, kind);
    return createSource(scope, {
      title,
      kind,
      sourceUrl,
      filename,
      original,
      pages,
      contentType: kind === "pdf" ? "application/pdf" : kind === "csv" ? "text/csv" : "text/plain",
    });
  });
}
