import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { z } from "zod";
import { HttpError } from "./http";
import { workspaceFor } from "./db";

export const LOCAL_ACTOR = "00000000-0000-4000-8000-000000000001";
export const authMode = () => (process.env.AERION_LOCAL_AUTH === "true" ? "local" : "supabase");
export async function supabaseAuth() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key)
    throw new HttpError(
      503,
      "Authentication is not configured. Configure Supabase, or use explicit local access for development.",
    );
  const store = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (values) => {
        for (const { name, value, options } of values)
          store.set(name, value, {
            ...options,
            sameSite: "lax",
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
          });
      },
    },
  });
}
export async function requireScope(request: Request) {
  let actorId: string;
  if (authMode() === "local") {
    const host = new URL(request.url).hostname;
    const headerHost = request.headers.get("host")
      ? new URL(`http://${request.headers.get("host")}`).hostname
      : null;
    if (
      process.env.NODE_ENV === "production" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(host) ||
      (headerHost && !["localhost", "127.0.0.1", "[::1]"].includes(headerHost))
    )
      throw new HttpError(
        403,
        "Local access is restricted to a development server on this machine.",
      );
    actorId = LOCAL_ACTOR;
  } else {
    const supabase = await supabaseAuth();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw new HttpError(401, "Sign in to your Aerion workspace.");
    actorId = z.uuid().parse(data.user.id);
  }
  return workspaceFor(actorId);
}
