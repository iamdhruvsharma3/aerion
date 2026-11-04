import { requireScope } from "@/server/auth";
import { respond } from "@/server/http";
import { readTransactions } from "@/server/transactions/workflow";
export async function GET(request: Request) {
  return respond(async () => readTransactions(await requireScope(request)));
}
