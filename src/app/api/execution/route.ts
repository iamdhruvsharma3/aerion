import { requireScope } from "@/server/auth";
import { readExecutionAttention } from "@/server/execution";
import { respond } from "@/server/http";
export async function GET(request: Request) {
  return respond(async () => readExecutionAttention(await requireScope(request)));
}
