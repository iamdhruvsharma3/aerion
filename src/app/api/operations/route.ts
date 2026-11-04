import { requireScope } from "@/server/auth";
import { respond, sameOrigin, jsonBody } from "@/server/http";
import { readOperations, updateOperations } from "@/server/operations/service";
export async function GET(request: Request) {
  return respond(async () => readOperations(await requireScope(request)));
}
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    return updateOperations(await requireScope(request), await jsonBody(request));
  });
}
