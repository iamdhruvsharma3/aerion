import { requireScope } from "@/server/auth";
import { respond } from "@/server/http";
import { readIntelligence } from "@/server/intelligence";
export async function GET(request: Request) {
  return respond(async () =>
    readIntelligence(
      await requireScope(request),
      Object.fromEntries(new URL(request.url).searchParams),
    ),
  );
}
