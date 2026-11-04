import { z } from "zod";
import { requireScope } from "@/server/auth";
import { respond, jsonBody, sameOrigin } from "@/server/http";
import { changeRun, readAgentRun } from "@/server/agents/repository";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () =>
    readAgentRun(await requireScope(request), z.uuid().parse((await context.params).id)),
  );
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const input = z
      .object({ operation: z.enum(["cancel", "retry"]), revision: z.number().int().nonnegative() })
      .parse(await jsonBody(request));
    return changeRun(
      await requireScope(request),
      z.uuid().parse((await context.params).id),
      input.revision,
      input.operation,
    );
  });
}
