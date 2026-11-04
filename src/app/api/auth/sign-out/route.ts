import { supabaseAuth } from "@/server/auth";
import { HttpError, respond, sameOrigin } from "@/server/http";
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const client = await supabaseAuth();
    const { error } = await client.auth.signOut();
    if (error) throw new HttpError(503, "Sign-out could not be completed. Please retry.");
    return { ok: true };
  });
}
