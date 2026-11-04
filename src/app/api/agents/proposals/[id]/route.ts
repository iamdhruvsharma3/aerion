import { z } from "zod";
import { requireScope } from "@/server/auth";
import { respond, jsonBody, sameOrigin } from "@/server/http";
import { decideProposal } from "@/server/agents/repository";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    return decideProposal(
      await requireScope(request),
      z.uuid().parse((await context.params).id),
      z
        .object({
          decision: z.enum(["accept", "reject"]),
          revision: z.number().int().nonnegative(),
          note: z.string().trim().min(5).max(2000),
          attested: z.boolean(),
        })
        .parse(await jsonBody(request)),
    );
  });
}
