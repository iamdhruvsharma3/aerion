import { parseCsv } from "../import";
import {
  fieldNames,
  type ExtractionOutput,
  type Fact,
  type FieldName,
  type SourcePage,
} from "./schema";
import { hasLeaseLanguage, hasSaleLanguage, leaseBasisSupported } from "./commercial-evidence";

const numericFields = new Set<FieldName>(["year", "hours", "cycles", "price", "leaseRate"]);
function convert(field: FieldName, raw: string): string | number {
  if (!numericFields.has(field)) return raw.trim();
  const clean = (
    field === "price" || field === "leaseRate"
      ? raw
          .trim()
          .replace(/^USD\s*/i, "")
          .replace(/\s*USD$/i, "")
      : raw.trim()
  ).replace(/,/g, "");
  return /^\d+(\.\d+)?$/.test(clean) ? Number(clean) : raw;
}

/** Original CSV records, including quoted newlines, are retained verbatim as row evidence. */
function csvRecords(text: string) {
  const records: string[] = [];
  let quoted = false,
    start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '"') {
      if (quoted && text[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (!quoted && /[\r\n]/.test(text[index])) {
      if (text.slice(start, index).trim()) records.push(text.slice(start, index));
      if (text[index] === "\r" && text[index + 1] === "\n") index++;
      start = index + 1;
    }
  }
  if (text.slice(start).trim()) records.push(text.slice(start));
  return records;
}
function offering(text: string) {
  return hasSaleLanguage(text) && hasLeaseLanguage(text)
    ? "Sale or lease"
    : hasLeaseLanguage(text)
      ? "Lease"
      : hasSaleLanguage(text)
        ? "Sale"
        : null;
}
function leaseMetadata(quote: string, page: number): Fact[] {
  const currency =
    quote.match(/\b[A-Z]{3}\b/)?.[0] ??
    quote.match(/\b(?:USD|EUR|GBP|INR|AED|CHF|CAD|AUD|SGD|JPY|KWD)\b/i)?.[0].toUpperCase() ??
    (/US\$/.test(quote) ? "USD" : null);
  const basis = leaseBasisSupported(quote, "Monthly rent")
    ? "Monthly rent"
    : leaseBasisSupported(quote, "Hourly rate")
      ? "Hourly rate"
      : null;
  return [
    ...(currency ? [{ field: "leaseCurrency" as const, value: currency, quote, page }] : []),
    ...(basis ? [{ field: "leaseBasis" as const, value: basis, quote, page }] : []),
    ...(hasLeaseLanguage(quote)
      ? [{ field: "offering" as const, value: offering(quote) ?? "Lease", quote, page }]
      : []),
  ];
}

/** Exact labelled values only: no model guessing, unit conversion, or inferred facts. */
export function extractLocally(
  pages: SourcePage[],
  kind: "text" | "csv" | "pdf",
): ExtractionOutput {
  if (kind === "csv") {
    const text = pages
      .map((p) => p.text)
      .join("\n")
      .replace(/^\uFEFF/, "");
    const rows = parseCsv(text);
    if (rows.length < 2 || rows.length > 101)
      throw new Error("CSV needs a header and 1–100 aircraft rows.");
    const headers = rows[0];
    const records = csvRecords(text);
    if (new Set(headers).size !== headers.length) throw new Error("CSV headers must be unique.");
    return {
      candidates: rows.slice(1).map((row, rowIndex) => {
        if (row.length !== headers.length)
          throw new Error("CSV row length does not match the header.");
        return {
          facts: headers.flatMap((header, index): Fact[] => {
            if (!fieldNames.includes(header as FieldName) || !row[index]) return [];
            const raw = row[index];
            const quote = records[rowIndex + 1].slice(0, 1500);
            return [
              {
                field: header as FieldName,
                value:
                  header === "offering"
                    ? (offering(raw) ?? raw)
                    : convert(header as FieldName, raw),
                quote,
                page: 1,
              },
            ];
          }),
        };
      }),
    };
  }
  const aliases: Record<string, FieldName> = {
    serialnumber: "serial",
    serial: "serial",
    market: "category",
    category: "category",
    flightHours: "hours",
    flighthours: "hours",
    flightcycles: "cycles",
    askingpriceusd: "price",
    priceusd: "price",
    purchasepriceusd: "price",
    salepriceusd: "price",
    leaserate: "leaseRate",
    leasecurrency: "leaseCurrency",
    leasebasis: "leaseBasis",
    offering: "offering",
    offeredtransaction: "offering",
    availabledate: "availableDate",
  };
  for (const field of fieldNames) aliases[field.toLowerCase()] = field;
  const candidates: ExtractionOutput["candidates"] = [];
  let facts: Fact[] = [];
  for (const page of pages) {
    for (const line of page.text.split(/\r?\n/)) {
      if (/^\s*---+\s*$/.test(line)) {
        if (facts.length) candidates.push({ facts });
        facts = [];
        continue;
      }
      const match = line.match(/^\s*([^:]{1,50}):\s*(.+?)\s*$/);
      if (!match) continue;
      const label = match[1].toLowerCase().replace(/[^a-z]/g, "");
      const field =
        aliases[label] ??
        (/^(?:lease|rental|monthlylease|hourlylease)rate/.test(label) ? "leaseRate" : undefined);
      if (!field || /^(unknown|not supplied|n\/a|tbd)$/i.test(match[2])) continue;
      if (field === "price" && !/usd/i.test(match[1]) && !/^USD\s*\d|\d\s*USD$/i.test(match[2]))
        continue;
      const quote = line.trim().slice(0, 1500);
      if (field === "leaseRate") {
        const amount = match[2].match(
          /^(?:[A-Z]{3}|US\$)?\s*(\d[\d,]*(?:\.\d+)?)(?:\s*(?:[A-Z]{3})?\s*(?:(?:per|\/)\s*(?:month|mo|mth|hour|hr))?)?$/i,
        );
        facts.push(
          {
            field,
            value: amount ? Number(amount[1].replace(/,/g, "")) : match[2],
            quote,
            page: page.page,
          },
          ...leaseMetadata(quote, page.page),
        );
        continue;
      }
      facts.push({
        field,
        value: field === "offering" ? (offering(match[2]) ?? match[2]) : convert(field, match[2]),
        quote,
        page: page.page,
      });
    }
  }
  if (facts.length) candidates.push({ facts });
  for (const candidate of candidates) {
    if (
      candidate.facts.some(
        (fact) =>
          fact.field === "offering" &&
          !/^(?:lease|rental|monthlylease|hourlylease)\s*rate/i.test(fact.quote),
      )
    ) {
      candidate.facts = candidate.facts.filter(
        (fact) =>
          fact.field !== "offering" ||
          !/^(?:lease|rental|monthlylease|hourlylease)\s*rate/i.test(fact.quote),
      );
    }
  }
  if (!candidates.length)
    throw new Error(
      "No labelled aircraft fields found. Use field labels such as Manufacturer:, Model:, Serial:, Year:, or connect a model for free-form documents.",
    );
  if (candidates.length > 100 || candidates.some((c) => c.facts.length > 50))
    throw new Error(
      "Use up to 100 aircraft, with at most 50 observations per aircraft. Separate aircraft with ---.",
    );
  return { candidates };
}
