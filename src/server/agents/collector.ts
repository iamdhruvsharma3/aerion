import https from "node:https";
import { readFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { load } from "cheerio";
import type { SourceConnector } from "../../lib/agents/schema";
import { HttpError } from "../http";

export function publicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export function connectorUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443"))
    throw new HttpError(
      422,
      "Source connectors require a public HTTPS URL on port 443 without credentials.",
    );
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    /\.(localhost|local|internal|test|invalid)$/.test(hostname) ||
    !hostname.includes(".")
  )
    throw new HttpError(422, "Private and local hosts are not source connectors.");
  if (ipaddr.isValid(hostname) && !publicAddress(hostname))
    throw new HttpError(422, "Private or reserved addresses are not allowed.");
  if (
    [...url.searchParams.keys()].some((key) =>
      /^(api[_-]?key|access[_-]?token|key|auth|authorization|password|secret|token|signature)$/i.test(
        key,
      ),
    )
  )
    throw new HttpError(422, "Source connectors cannot contain credential query parameters.");
  url.hash = "";
  return url;
}
/** Resolve once, reject all private/reserved answers and pin the checked address to the TLS connection. */
export async function fetchPublicSource(
  raw: string,
  remaining = 3,
  approvedOrigin?: string,
  signal?: AbortSignal,
): Promise<{ original: Buffer; contentType: string; url: string }> {
  const url = connectorUrl(raw);
  if (approvedOrigin && url.origin !== approvedOrigin)
    throw new HttpError(
      422,
      "This source redirects to another origin. Register that URL explicitly before collection.",
    );
  const answers = await lookup(url.hostname, { all: true, verbatim: true });
  if (!answers.length || answers.some((a) => !publicAddress(a.address)))
    throw new HttpError(422, "The source resolved to a private or reserved address.");
  const chosen = answers.find((answer) => answer.family === 4) ?? answers[0];
  const extraCa = process.env.AERION_EXTRA_CA_FILE
    ? await readFile(process.env.AERION_EXTRA_CA_FILE, "utf8")
    : null;
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        agent: false,
        ...(extraCa ? { ca: [...rootCertificates, extraCa] } : {}),
        family: chosen.family,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000),
        lookup: (_hostname, _options, callback) => callback(null, chosen.address, chosen.family),
        headers: {
          "User-Agent": "AerionSourceCollector/0.1",
          Accept:
            "text/html,application/rss+xml,application/atom+xml,application/json,text/plain,application/pdf",
          "Accept-Encoding": "identity",
        },
      },
      (response) => {
        const code = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(code)) {
          response.resume();
          if (!remaining || !response.headers.location) {
            reject(new HttpError(422, "Too many redirects or a missing redirect target."));
            return;
          }
          fetchPublicSource(
            new URL(response.headers.location, url).href,
            remaining - 1,
            approvedOrigin ?? url.origin,
            signal,
          ).then(resolve, reject);
          return;
        }
        if (code < 200 || code >= 300) {
          response.resume();
          reject(
            new HttpError(
              422,
              `Source returned HTTP ${code}. Collection stopped; access restrictions are not bypassed.`,
            ),
          );
          return;
        }
        if (
          response.headers["content-encoding"] &&
          response.headers["content-encoding"] !== "identity"
        ) {
          response.resume();
          reject(
            new HttpError(422, "Compressed responses are not accepted by this bounded collector."),
          );
          return;
        }
        if (Number(response.headers["content-length"] ?? 0) > 2_000_000) {
          response.destroy();
          reject(new HttpError(413, "This source exceeds the 2 MB collection limit."));
          return;
        }
        const parts: Buffer[] = [];
        let length = 0;
        response.on("data", (part: Buffer) => {
          length += part.length;
          if (length > 2_000_000) {
            response.destroy(new Error("Source exceeds the 2 MB collection limit."));
            return;
          }
          parts.push(part);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            original: Buffer.concat(parts),
            contentType: response.headers["content-type"] ?? "text/plain",
            url: url.href,
          }),
        );
      },
    );
    request.setTimeout(15_000, () => request.destroy(new Error("Source collection timed out.")));
    request.on("error", reject);
  });
}
export function connectorText(
  original: Buffer,
  format: SourceConnector["format"],
  contentType: string,
  options: { businessContacts?: boolean } = {},
) {
  if (original.includes(0))
    throw new HttpError(
      422,
      "This connector returned binary content. Use PDF upload for PDF documents.",
    );
  const raw = original.toString("utf8");
  let text: string;
  if (format === "feed") {
    const $ = load(raw, { xml: true });
    const entries = $("item, entry").toArray();
    if (!entries.length)
      throw new HttpError(422, "The feed contains no RSS items or Atom entries.");
    text = entries
      .slice(0, 50)
      .map((entry) => {
        const item = $(entry),
          title = item.find("title").first().text().trim();
        const description = item
          .find("description, summary, content, content\\:encoded")
          .first()
          .text();
        const clean = load(description).text().replace(/\s+/g, " ").trim();
        const link = item.find("link").first();
        return [
          title,
          clean,
          `Published: ${item.find("pubDate, published, updated").first().text().trim()}`,
          `Source URL: ${link.attr("href") ?? link.text().trim()}`,
        ].join("\n");
      })
      .join("\n---\n");
  } else if (format === "json") {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new HttpError(422, "The connector response is not valid JSON.");
    }
    text = JSON.stringify(value, null, 2);
  } else if (format === "page") {
    if (!/html|xml|text\/plain/i.test(contentType))
      throw new HttpError(422, "The page connector returned an unsupported content type.");
    const $ = load(raw);
    const pageTitle = $("title").text().trim();
    $(
      options.businessContacts
        ? "script,style,nav,form,iframe,noscript,svg"
        : "script,style,nav,header,footer,form,iframe,noscript,svg",
    ).remove();
    if (options.businessContacts)
      $("a[href]").each((_i, element) => {
        const item = $(element),
          href = item.attr("href") ?? "";
        try {
          if (/^mailto:/i.test(href)) {
            const email = decodeURIComponent(href.slice(7).split("?")[0]);
            if (/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email) && email.length <= 254)
              item.append(` [Published email: ${email}]`);
          } else if (/^tel:/i.test(href)) {
            const phone = decodeURIComponent(href.slice(4).split("?")[0]);
            if (/^[+()\d .-]{6,80}$/.test(phone)) item.append(` [Published phone: ${phone}]`);
          }
        } catch {
          /* Malformed link attributes do not establish a contact. */
        }
      });
    $("br").replaceWith("\n");
    $("p,div,li,h1,h2,h3,h4,tr").append("\n");
    const main = $("main,article").first();
    text = (options.businessContacts ? $("body") : main.length ? main : $("body"))
      .text()
      .split(/\n/)
      .map((line) => line.replace(/[\t ]+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
    if (options.businessContacts && pageTitle) text = `Publisher page title: ${pageTitle}\n${text}`;
  } else {
    text = raw;
  }
  if (!text.trim()) throw new HttpError(422, "No readable source text was returned.");
  if (text.length > 200_000)
    throw new HttpError(
      413,
      "Extracted connector text exceeds 200,000 characters. Choose a more specific URL.",
    );
  return text;
}
