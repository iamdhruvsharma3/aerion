import { z } from "zod";
import { requireScope } from "@/server/auth";
import { jsonBody, respond, sameOrigin } from "@/server/http";
import { decideSignal, readSignal } from "@/server/intelligence";
import { signalDecisionSchema } from "@/lib/intelligence/market-schema";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () =>
    readSignal(await requireScope(request), z.uuid().parse((await context.params).id)),
  );
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const scope = await requireScope(request);
    return decideSignal(
      scope,
      z.uuid().parse((await context.params).id),
      signalDecisionSchema.parse(await jsonBody(request)),
    );
  });
}
