import { z } from "zod";
import { executionActionSchema } from "@/lib/execution/schema";
import { requireScope } from "@/server/auth";
import { jsonBody, respond, sameOrigin } from "@/server/http";
import { readExecution, mutateExecution } from "@/server/execution";
const idSchema = z.string().min(1).max(300);
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () =>
    readExecution(await requireScope(request), idSchema.parse((await context.params).id)),
  );
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const scope = await requireScope(request);
    const input = z
      .object({ revision: z.number().int().nonnegative(), action: executionActionSchema })
      .parse(await jsonBody(request));
    return mutateExecution(
      scope,
      idSchema.parse((await context.params).id),
      input.action,
      input.revision,
    );
  });
}
