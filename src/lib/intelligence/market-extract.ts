import { parseCsv } from "../import";
import type { SourcePage } from "./schema";
import {
  marketOutputSchema,
  signalFields,
  signalLabels,
  signalValuesSchema,
  type MarketOutput,
  type SignalFact,
  type SignalField,
  type SignalValues,
} from "./market-schema";

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const aliases: Record<string, SignalField> = {
  organization: "organization",
  organisation: "organization",
  company: "organization",
  aircraftfamily: "aircraftFamily",
  signaltype: "intent",
  intent: "intent",
  market: "market",
  geography: "geography",
  eventdate: "eventDate",
  quantity: "quantity",
};
const fieldFor = (raw: string) => aliases[raw.toLowerCase().replace(/[^a-z]/g, "")];
function valueFor(field: SignalField, raw: string) {
  return field === "quantity" && /^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)$/.test(raw.trim())
    ? Number(raw.replace(/,/g, ""))
    : raw.trim();
}

/** Bounded local parser. Headlines classify completed orders as activity, never live demand. */
export function extractMarketLocally(
  pages: SourcePage[],
  kind: "text" | "pdf" | "csv",
): MarketOutput {
  const signals: MarketOutput["signals"] = [];
  if (kind === "csv") {
    const text = pages
      .map((p) => p.text)
      .join("\n")
      .replace(/^\uFEFF/, "");
    const rows = parseCsv(text);
    if (rows.length < 2 || rows.length > 101)
      throw new Error("Market CSV needs a header and 1–100 rows.");
    const headers = rows[0].map(fieldFor);
    const known = headers.filter(Boolean);
    if (new Set(known).size !== known.length) throw new Error("Market CSV headers must be unique.");
    for (const row of rows.slice(1)) {
      if (row.length !== headers.length)
        throw new Error("CSV row length does not match its header.");
      const facts = row.flatMap((raw, index): SignalFact[] => {
        const field = headers[index];
        if (!field || !raw.trim()) return [];
        // Preserve escaped CSV text as the passage; validation also checks its decoded value.
        return [
          {
            field,
            value: valueFor(field, raw),
            quote: text.includes(raw) ? raw : raw.replace(/"/g, '""'),
            page: 1,
            method: "label",
          },
        ];
      });
      if (facts.length) signals.push({ facts });
    }
  } else {
    let facts: SignalFact[] = [];
    const flush = () => {
      if (facts.length) signals.push({ facts });
      facts = [];
    };
    for (const page of pages) {
      for (const raw of page.text.split(/\r?\n/)) {
        const line = raw.trim();
        if (/^---+$/.test(line)) {
          flush();
          continue;
        }
        const label = line.match(/^([^:]{1,50}):\s*(.+)$/);
        const field = label && fieldFor(label[1]);
        if (field && label && !/^(unknown|n\/a|tbd|not supplied)$/i.test(label[2])) {
          facts.push({
            field,
            value: valueFor(field, label[2]),
            quote: line.slice(0, 1500),
            page: page.page,
            method: "label",
          });
          continue;
        }
        // A deliberately narrow headline grammar; complex prose remains unsupported locally.
        const headline = line.match(
          /^([\p{L}\d][\p{L}\d &'’().-]{1,100}?) orders (?:(\d+) (?:additional )?)([\p{L}\d -]{2,80}?) (?:aircraft|jets|airplanes)\.?$/u,
        );
        if (headline) {
          flush();
          signals.push({
            facts: [
              {
                field: "organization",
                value: headline[1],
                quote: line,
                page: page.page,
                method: "headline",
              },
              {
                field: "quantity",
                value: Number(headline[2]),
                quote: line,
                page: page.page,
                method: "headline",
              },
              {
                field: "aircraftFamily",
                value: headline[3],
                quote: line,
                page: page.page,
                method: "headline",
              },
              {
                field: "intent",
                value: "Fleet activity",
                quote: line,
                page: page.page,
                method: "headline",
              },
            ],
          });
        }
      }
    }
    flush();
  }
  if (!signals.length)
    throw new Error(
      "No supported market signals found. Use the market labels or CSV template; free-form AI market extraction is not connected.",
    );
  return marketOutputSchema.parse({ signals });
}

export function validateMarketEvidence(output: MarketOutput, pages: SourcePage[]) {
  return marketOutputSchema.parse(output).signals.map((signal) => {
    const facts: SignalFact[] = [];
    const warnings: string[] = [];
    for (const fact of signal.facts) {
      const passage = normalize(fact.quote);
      const page = pages.find((p) => p.page === fact.page);
      const value = signalValuesSchema.shape[fact.field].safeParse(fact.value);
      const activity =
        fact.field === "intent" &&
        fact.method === "headline" &&
        fact.value === "Fleet activity" &&
        /^[\p{L}\d][\p{L}\d &'’().-]{1,100}? orders \d+ (?:additional )?[\p{L}\d -]{2,80}? (?:aircraft|jets|airplanes)\.?$/u.test(
          passage,
        );
      const stated =
        fact.field === "intent" && fact.method === "model"
          ? supportedIntent(passage) === fact.value ||
            (/^(?:signal type|intent):\s*(Demand|Supply|Fleet activity)$/i.test(passage) &&
              passage.toLowerCase().endsWith(String(fact.value).toLowerCase()))
          : activity ||
            (typeof fact.value === "number"
              ? new RegExp(`(^|[^\\d.])${fact.value}([^\\d.]|$)`).test(passage.replace(/,/g, ""))
              : passage
                  .replace(/""/g, '"')
                  .toLowerCase()
                  .includes(normalize(fact.value).toLowerCase()));

      if (!page || !normalize(page.text).includes(passage) || !value.success || !stated) {
        warnings.push(`${signalLabels[fact.field]}: unsupported observation removed.`);
        continue;
      }
      if (
        !facts.some(
          (f) =>
            f.field === fact.field &&
            f.value === fact.value &&
            f.quote === fact.quote &&
            f.page === fact.page,
        )
      )
        facts.push(fact);
    }
    const values: Record<string, string | number> = {};
    let conflict = false;
    for (const field of signalFields) {
      const observations = facts.filter((f) => f.field === field);
      if (new Set(observations.map((f) => f.value)).size > 1) {
        conflict = true;
        warnings.push(
          `${signalLabels[field]}: conflicting observations; resolve with a review note.`,
        );
      }
      if (observations.length) values[field] = observations[0].value;
    }
    const complete = values.organization && values.aircraftFamily && values.intent;
    if (!complete) warnings.push("Organization, aircraft family, or signal type is missing.");
    if (values.intent === "Fleet activity")
      warnings.push("Fleet activity does not establish an open buying mandate.");
    if (facts.some((f) => f.method === "headline"))
      warnings.push(
        "Order headline classified by a local rule. Market, geography and event date are not inferred.",
      );
    return {
      facts,
      values: signalValuesSchema.parse(values) as SignalValues,
      warnings,
      confidence: conflict
        ? ("Conflicting" as const)
        : complete
          ? ("Stated" as const)
          : ("Incomplete" as const),
    };
  });
}

/** A model's intent label must still have an explicit supporting statement; news is never confirmation. */
export function supportedIntent(quote: string) {
  if (
    /\b(?:not|no longer|never|cancelled|canceled|rumou?r|may|might|could|forecast)\b/i.test(quote)
  )
    return null;
  const demand =
    /\b(?:seeking|looking for|requires?|wanted|requesting|intends? to (?:buy|acquire)|plans? to (?:buy|acquire))\b/i.test(
      quote,
    );
  const supply =
    /\b(?:available for (?:sale|lease)|offered for (?:sale|lease)|for sale|for lease)\b/i.test(
      quote,
    );
  const fleet =
    /\b(?:orders?|ordered|deliver(?:ed|y)|takes? delivery|signed.{0,40}firm order|placed.{0,30}order)\b/i.test(
      quote,
    );
  if (Number(demand) + Number(supply) + Number(fleet) !== 1) return null;
  return demand ? "Demand" : supply ? "Supply" : "Fleet activity";
}
