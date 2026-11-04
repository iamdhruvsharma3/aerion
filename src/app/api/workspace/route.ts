import { z } from "zod";
import { requireScope } from "@/server/auth";
import { jsonBody, respond, sameOrigin } from "@/server/http";
import { mutateWorkspace, readWorkspace } from "@/server/repository";
import { actionSchema } from "@/lib/workspace";
export const runtime = "nodejs";
export async function GET(request: Request) {
  return respond(async () => readWorkspace(await requireScope(request)));
}
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const scope = await requireScope(request);
    const { action, revision } = z
      .object({ action: actionSchema, revision: z.number().int().nonnegative() })
      .parse(await jsonBody(request));
    return mutateWorkspace(scope, action, revision);
  });
}
