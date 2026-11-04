import { z } from "zod";
import { requireScope } from "@/server/auth";
import { respond, jsonBody, sameOrigin } from "@/server/http";
import { decideDelivery } from "@/server/agents/delivery";
import { deliveryDecisionSchema } from "@/lib/agents/mail-schema";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    return decideDelivery(
      await requireScope(request),
      z.uuid().parse((await context.params).id),
      deliveryDecisionSchema.parse(await jsonBody(request)),
    );
  });
}
