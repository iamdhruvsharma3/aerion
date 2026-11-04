import { modelProviderIds } from "@/lib/agents/providers";
import { z } from "zod";
import { requireScope } from "@/server/auth";
import { jsonBody, respond, sameOrigin } from "@/server/http";
import { enqueueExtraction } from "@/server/jobs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const scope = await requireScope(request);
    const { provider } = z
      .object({ provider: z.enum(["local", ...modelProviderIds]) })
      .parse(await jsonBody(request));
    return enqueueExtraction(scope, z.uuid().parse((await context.params).id), provider);
  });
}
