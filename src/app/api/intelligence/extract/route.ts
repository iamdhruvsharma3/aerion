import { z } from "zod";
import { requireScope } from "@/server/auth";
import { HttpError, jsonBody, respond, sameOrigin } from "@/server/http";
import { enqueueExtraction } from "@/server/jobs";
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const scope = await requireScope(request);
    const { ids } = z
      .object({ ids: z.array(z.uuid()).min(1).max(100) })
      .parse(await jsonBody(request));
    const results = [];
    for (const id of new Set(ids)) {
      try {
        const job = await enqueueExtraction(scope, id, "local", "market");
        results.push({ id, status: "queued", jobId: job.id });
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        results.push({ id, status: "skipped", error: error.message });
      }
    }
    return { results };
  });
}
