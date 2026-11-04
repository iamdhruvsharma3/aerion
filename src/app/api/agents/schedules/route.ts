import { requireScope } from "@/server/auth";
import { respond, jsonBody, sameOrigin } from "@/server/http";
import { saveSchedule } from "@/server/agents/repository";
import { scheduleSchema } from "@/lib/agents/schema";
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    return saveSchedule(await requireScope(request), scheduleSchema.parse(await jsonBody(request)));
  });
}
