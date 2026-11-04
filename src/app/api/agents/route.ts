import { z } from "zod";
import { requireScope } from "@/server/auth";
import { respond, jsonBody, sameOrigin } from "@/server/http";
import { enqueueAgent, readAgentCenter } from "@/server/agents/repository";
import { runInputSchema } from "@/lib/agents/schema";
export async function GET(request: Request) {
  return respond(async () =>
    readAgentCenter(
      await requireScope(request),
      z.coerce
        .number()
        .int()
        .min(1)
        .max(100000)
        .parse(new URL(request.url).searchParams.get("page") ?? 1),
    ),
  );
}
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    return enqueueAgent(await requireScope(request), runInputSchema.parse(await jsonBody(request)));
  });
}
