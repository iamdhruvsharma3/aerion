import { requireScope } from "@/server/auth";
import { jsonBody, respond, sameOrigin } from "@/server/http";
import { runInputSchema } from "@/lib/agents/schema";
import { enqueueAgent } from "@/server/agents/repository";
import { readDiscoveryCenter } from "@/server/discovery/repository";
import { HttpError } from "@/server/http";

export async function GET(request: Request) {
  return respond(async () => readDiscoveryCenter(await requireScope(request)));
}
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const scope = await requireScope(request);
    const input = runInputSchema.parse(await jsonBody(request));
    if (!input.discovery) throw new HttpError(422, "A discovery request is required.");
    return enqueueAgent(scope, input);
  });
}
