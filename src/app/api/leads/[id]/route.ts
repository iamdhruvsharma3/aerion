import { z } from "zod";
import { requireScope } from "@/server/auth";
import { jsonBody, respond, sameOrigin } from "@/server/http";
import { readLeadCase, mutateLeadCase } from "@/server/leads/workflow";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () =>
    readLeadCase(await requireScope(request), z.uuid().parse((await context.params).id)),
  );
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const scope = await requireScope(request);
    const input = z
      .object({ revision: z.number().int().nonnegative(), action: z.unknown() })
      .parse(await jsonBody(request));
    return mutateLeadCase(
      scope,
      z.uuid().parse((await context.params).id),
      input.revision,
      input.action,
    );
  });
}
