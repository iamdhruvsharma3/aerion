import { z } from "zod";
import { requireScope } from "@/server/auth";
import { respond, jsonBody, sameOrigin } from "@/server/http";
import { readMailStatus, queueDelivery } from "@/server/agents/delivery";
import { deliveryRequestSchema } from "@/lib/agents/mail-schema";
export async function GET(request: Request) {
  return respond(async () => {
    const draft = new URL(request.url).searchParams.get("draft");
    return readMailStatus(await requireScope(request), draft ? z.uuid().parse(draft) : undefined);
  });
}
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    return queueDelivery(
      await requireScope(request),
      deliveryRequestSchema.parse(await jsonBody(request)),
    );
  });
}
