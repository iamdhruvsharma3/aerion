import { ZodError } from "zod";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  // Next may canonicalize request.url to localhost; Host retains the browser's origin.
  const expected =
    process.env.AERION_APP_ORIGIN ||
    `${new URL(request.url).protocol}//${request.headers.get("host") || new URL(request.url).host}`;
  if (!origin || origin !== expected)
    throw new HttpError(403, "Request origin could not be verified.");
}
export async function jsonBody(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new HttpError(415, "Use application/json.");
  const bytes = await readBounded(request, 2_000_000);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}
export async function readBounded(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Request body is required.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > limit) {
      await reader.cancel();
      throw new HttpError(413, "Request is too large.");
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks);
}
export async function respond(run: () => Promise<unknown>) {
  try {
    return Response.json(await run(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status =
      error instanceof HttpError ? error.status : error instanceof ZodError ? 422 : 500;
    const message =
      error instanceof HttpError
        ? error.message
        : error instanceof ZodError
          ? error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
          : "The request could not be completed. Check the server configuration and try again.";
    if (status === 500)
      console.error(
        "Aerion request failed",
        error instanceof Error ? error.message : "Unknown error",
      );
    return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
