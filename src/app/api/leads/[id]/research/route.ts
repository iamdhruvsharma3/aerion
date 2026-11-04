import { z } from "zod";
import { requireScope } from "@/server/auth";
import { jsonBody, respond, sameOrigin } from "@/server/http";
import { researchLead } from "@/server/leads/research";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    return researchLead(
      await requireScope(request),
      z.uuid().parse((await context.params).id),
      await jsonBody(request),
    );
  });
}
