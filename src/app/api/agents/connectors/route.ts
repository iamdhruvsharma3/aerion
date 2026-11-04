import { requireScope } from "@/server/auth";
import { respond, jsonBody, sameOrigin } from "@/server/http";
import { saveConnector } from "@/server/agents/repository";
import { connectorSchema } from "@/lib/agents/schema";
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    return saveConnector(
      await requireScope(request),
      connectorSchema.parse(await jsonBody(request)),
    );
  });
}
