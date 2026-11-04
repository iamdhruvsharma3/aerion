import { z } from "zod";
import { requireScope } from "@/server/auth";
import { jsonBody, respond, sameOrigin } from "@/server/http";
import { mutateRevenue, readRevenueDetail } from "@/server/revenue/repository";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () =>
    readRevenueDetail(await requireScope(request), z.uuid().parse((await context.params).id)),
  );
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    return mutateRevenue(
      await requireScope(request),
      z.uuid().parse((await context.params).id),
      await jsonBody(request),
    );
  });
}
