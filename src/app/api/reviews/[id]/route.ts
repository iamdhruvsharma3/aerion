import { z } from "zod";
import { requireScope } from "@/server/auth";
import { jsonBody, respond, sameOrigin } from "@/server/http";
import { decideReview, readReview, reviewDecisionSchema } from "@/server/repository";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const scope = await requireScope(request);
    return decideReview(
      scope,
      z.uuid().parse((await context.params).id),
      reviewDecisionSchema.parse(await jsonBody(request)),
    );
  });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () =>
    readReview(await requireScope(request), z.uuid().parse((await context.params).id)),
  );
}
