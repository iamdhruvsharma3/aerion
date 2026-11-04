import { requireScope } from "@/server/auth";
import { jsonBody, respond, sameOrigin } from "@/server/http";
import { decideSuppression } from "@/server/communication/service";
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    return decideSuppression(await requireScope(request), await jsonBody(request));
  });
}
