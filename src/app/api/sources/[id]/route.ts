import { z } from "zod";
import { requireScope } from "@/server/auth";
import { respond } from "@/server/http";
import { readSource } from "@/server/repository";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () =>
    readSource(await requireScope(request), z.uuid().parse((await context.params).id)),
  );
}
