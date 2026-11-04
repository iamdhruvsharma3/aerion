import { z } from "zod";
import { requireScope } from "@/server/auth";
import { jsonBody, respond, sameOrigin } from "@/server/http";
import { readCommunicationMessage, actOnCommunication } from "@/server/communication/service";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () =>
    readCommunicationMessage(
      await requireScope(request),
      z.uuid().parse((await context.params).id),
    ),
  );
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    return actOnCommunication(
      await requireScope(request),
      z.uuid().parse((await context.params).id),
      await jsonBody(request),
    );
  });
}
