import { z } from "zod";
import { requireScope } from "@/server/auth";
import { HttpError, readBounded, respond, sameOrigin } from "@/server/http";
import { readCommunicationInbox, retainEmailUpload } from "@/server/communication/service";
export const runtime = "nodejs";
export async function GET(request: Request) {
  return respond(async () => readCommunicationInbox(await requireScope(request)));
}
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const scope = await requireScope(request),
      contentType = request.headers.get("content-type") ?? "";
    if (!contentType.startsWith("multipart/form-data;"))
      throw new HttpError(415, "Upload an original .eml message.");
    const bytes = await readBounded(request, 2_100_000);
    const form = await new Response(new Uint8Array(bytes), {
      headers: { "content-type": contentType },
    }).formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.size || !/\.eml$/i.test(file.name))
      throw new HttpError(422, "Choose an original .eml email file up to 2 MB.");
    z.number().max(2_000_000).parse(file.size);
    return retainEmailUpload(scope, Buffer.from(await file.arrayBuffer()), file.name);
  });
}
