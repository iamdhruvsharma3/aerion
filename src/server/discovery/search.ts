import { z } from "zod";
import type { DiscoveryInput } from "../../lib/discovery/schema";
import { connectorUrl } from "../agents/collector";
import { HttpError } from "../http";

export const searchConfiguration = () => ({
  ready: Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim()),
  detail: process.env.BRAVE_SEARCH_API_KEY?.trim()
    ? "Brave Search connected. One search and up to three public pages per run."
    : "Add BRAVE_SEARCH_API_KEY to .env.local and restart Aerion. Specific public URLs work without a search key.",
});
const resultSchema = z.object({
  url: z.url(),
  title: z.string(),
  description: z.string().nullish(),
});
const responseSchema = z.object({ web: z.object({ results: z.array(z.unknown()) }).nullish() });
export type SearchHit = { url: string; title: string; snippet: string };
export function parseSearchResults(raw: unknown): SearchHit[] {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(502, "Brave returned an invalid search response.");
  const results: SearchHit[] = [],
    seen = new Set<string>();
  for (const item of parsed.data.web?.results ?? []) {
    const result = resultSchema.safeParse(item);
    if (!result.success) continue;
    try {
      const url = connectorUrl(result.data.url).href;
      if (seen.has(url)) continue;
      seen.add(url);
      results.push({
        url,
        title: result.data.title.slice(0, 300),
        snippet: (result.data.description ?? "").slice(0, 2000),
      });
      if (results.length === 6) break;
    } catch {
      /* Unsafe or authenticated URLs are not offered to the collector. */
    }
  }
  return results;
}
/** The API token is only sent to this pinned HTTPS endpoint; redirects and automatic retries are disabled. */
export async function searchWeb(input: DiscoveryInput, signal: AbortSignal) {
  if (!searchConfiguration().ready) throw new HttpError(503, searchConfiguration().detail);
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", input.query);
  url.searchParams.set("count", "6");
  url.searchParams.set("search_lang", "en");
  url.searchParams.set("text_decorations", "false");
  url.searchParams.set("result_filter", "web");
  if (input.freshness !== "any")
    url.searchParams.set("freshness", input.freshness === "month" ? "pm" : "py");
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY?.trim() ?? "",
      },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(
        response.status === 429 ? 429 : 502,
        `Brave Search returned HTTP ${response.status}. Check the API account and its search allowance; this run will not retry the search automatically.`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new HttpError(502, "Brave returned an empty response.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 2_000_000) throw new HttpError(413, "Search response exceeds 2 MB.");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const original = Buffer.concat(chunks);
    let body: unknown;
    try {
      body = JSON.parse(original.toString("utf8"));
    } catch {
      throw new HttpError(502, "Brave returned invalid JSON.");
    }
    return { original, results: parseSearchResults(body) };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    signal.throwIfAborted();
    throw new HttpError(
      502,
      "Brave Search could not be reached within the request limit. No search retry was made.",
    );
  }
}
