import { z } from "zod";
import { requireScope } from "@/server/auth";
import { respond } from "@/server/http";
import { readSource } from "@/server/repository";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  let document: Awaited<ReturnType<typeof readSource>> | undefined;
  const error = await respond(async () => {
    document = await readSource(
      await requireScope(request),
      z.uuid().parse((await context.params).id),
      true,
    );
    return {};
  });
  if (!document) return error;
  return new Response(new Uint8Array(document.original), {
    headers: {
      "Content-Type": document.contentType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.filename).replace(/'/g, "%27")}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
