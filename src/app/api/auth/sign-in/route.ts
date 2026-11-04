import { z } from "zod";
import { supabaseAuth } from "@/server/auth";
import { HttpError, jsonBody, respond, sameOrigin } from "@/server/http";
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const input = z
      .object({ email: z.email().max(300), password: z.string().min(1).max(300) })
      .parse(await jsonBody(request));
    const client = await supabaseAuth();
    const { error } = await client.auth.signInWithPassword(input);
    if (error) throw new HttpError(401, "Sign-in failed. Check your credentials and try again.");
    return { ok: true };
  });
}
