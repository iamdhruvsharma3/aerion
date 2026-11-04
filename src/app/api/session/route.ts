import { authMode, requireScope } from "@/server/auth";
import { respond } from "@/server/http";
export async function GET(request: Request) {
  return respond(async () => ({ ...(await requireScope(request)), mode: authMode() }));
}
