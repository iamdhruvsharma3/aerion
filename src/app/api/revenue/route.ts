import { requireScope } from "@/server/auth";
import { jsonBody, respond, sameOrigin } from "@/server/http";
import { createEngagement, readRevenueCenter } from "@/server/revenue/repository";
export async function GET(request: Request) {
  return respond(async () => readRevenueCenter(await requireScope(request)));
}
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    return createEngagement(await requireScope(request), await jsonBody(request));
  });
}
