import { z } from "zod";
import { requireScope } from "@/server/auth";
import { respond, sameOrigin, jsonBody } from "@/server/http";
import { readTransaction, mutateTransaction } from "@/server/transactions/workflow";
const id = z.string().min(1).max(300);
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () =>
    readTransaction(await requireScope(request), id.parse((await context.params).id)),
  );
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const input = z
      .object({
        revision: z.number().int().nonnegative(),
        idempotencyKey: z.uuid(),
        action: z.unknown(),
      })
      .parse(await jsonBody(request));
    return mutateTransaction(
      await requireScope(request),
      id.parse((await context.params).id),
      input.revision,
      input.idempotencyKey,
      input.action,
    );
  });
}
