import { parseCsv } from "../import";
/** Conservative source semantics: no currency conversion, annualisation or inferred commercial amounts. */
export const hasLeaseLanguage = (text: string) =>
  /\bleas(?:e|ing)\b|\brent(?:al)?\b|\bmonthly\b|\bhourly\b|\bper\s+(?:month|hour)\b|\/\s*(?:mo(?:nth)?|mth|hr|hour)\b/i.test(
    text,
  );
export const hasSaleLanguage = (text: string) =>
  /\b(?:sale|purchase|buy|buying)\b/i.test(
    text.replace(
      /\b(?:not|never|no)\s+(?:(?:available|offered)\s+)?(?:for\s+)?(?:sale|purchase)\b|\bsale\s+(?:is\s+)?(?:not available|unavailable)\b/gi,
      "",
    ),
  );
export const hasExplicitPurchasePrice = (text: string) =>
  /\b(?:purchase|sale)\s+(?:asking\s+)?(?:price|budget)\b|\b(?:price|budget)\s+(?:for\s+)?(?:purchase|sale)\b/i.test(
    text,
  );
export function leaseBasisSupported(text: string, basis: string) {
  return basis === "Monthly rent"
    ? /\bmonth(?:ly)?\b|\/\s*(?:mo|mth)\b/i.test(text)
    : basis === "Hourly rate" && /\bhour(?:ly)?\b|\/\s*hr\b/i.test(text);
}
export function currencySupported(text: string, currency: string) {
  return (
    new RegExp(`\\b${currency}\\b`, "i").test(text) || (currency === "USD" && /US\$/i.test(text))
  );
}
export function amountSupported(text: string, amount: number) {
  return new RegExp(`(^|[^\\d.])${String(amount).replace(".", "\\.")}([^\\d.]|$)`).test(
    text.replace(/,/g, ""),
  );
}
/** Bind the number to its own currency/periodic statement; separate labelled units remain supported. */
export function leaseAmountSupported(
  text: string,
  amount: number,
  currency: string,
  basis: string,
) {
  return text.split(/\r?\n|;|\bor\b|(?<=[.!?])\s+/i).some((clause) => {
    if (!amountSupported(clause, amount)) return false;
    const currencies = clause.match(/\b[A-Z]{3}\b/g) ?? [];
    if ((currencies.length || /US\$/.test(clause)) && !currencySupported(clause, currency))
      return false;
    const hasUnits =
      leaseBasisSupported(clause, "Monthly rent") || leaseBasisSupported(clause, "Hourly rate");
    if (
      !/lease|rent|budget|rate/i.test(clause) &&
      !hasUnits &&
      !currencySupported(clause, currency)
    )
      return false;
    return !hasUnits || leaseBasisSupported(clause, basis);
  });
}
export function offeringSupported(text: string, offering: string) {
  if (offering === "Sale or lease") return hasSaleLanguage(text) && hasLeaseLanguage(text);
  if (offering === "Sale") return hasSaleLanguage(text);
  if (offering === "Lease")
    return hasLeaseLanguage(
      text.replace(
        /\b(?:not|never|no)\s+(?:(?:available|offered)\s+)?(?:for\s+)?lease\b|\blease\s+(?:is\s+)?(?:not available|unavailable)\b/gi,
        "",
      ),
    );
  return offering === "Not supplied" && /not supplied|unknown|not stated/i.test(text);
}
/** The documented typed CSV price column means purchase USD; rental meaning in that same row overrides it. */
export function csvPurchaseAmountSupported(text: string, quote: string, amount: number) {
  try {
    const rows = parseCsv(text),
      headers = rows[0],
      priceIndex = headers.indexOf("price");
    if (priceIndex < 0) return false;
    const quoted = parseCsv(quote)[0];
    const matching = rows
      .slice(1)
      .filter(
        (row) =>
          amountSupported(row[priceIndex] ?? "", amount) &&
          (quoted?.length === headers.length
            ? JSON.stringify(row) === JSON.stringify(quoted)
            : true),
      );
    return (
      matching.length > 0 &&
      matching.every((row) =>
        purchaseAmountSupported(row[priceIndex], amount, {
          csv: true,
          candidateText: row.join(" "),
        }),
      )
    );
  } catch {
    return false;
  }
}
export function csvLeaseAmountSupported(
  text: string,
  quote: string,
  amount: number,
  currency: string,
  basis: string,
) {
  try {
    const rows = parseCsv(text),
      headers = rows[0],
      rateIndex = headers.indexOf("leaseRate"),
      currencyIndex = headers.indexOf("leaseCurrency"),
      basisIndex = headers.indexOf("leaseBasis");
    if ([rateIndex, currencyIndex, basisIndex].some((index) => index < 0)) return false;
    const quoted = parseCsv(quote)[0];
    const matching = rows
      .slice(1)
      .filter(
        (row) =>
          amountSupported(row[rateIndex] ?? "", amount) &&
          (quoted?.length === headers.length
            ? JSON.stringify(row) === JSON.stringify(quoted)
            : true),
      );
    return (
      matching.length > 0 &&
      matching.every(
        (row) =>
          currencySupported(row[currencyIndex], currency) &&
          leaseBasisSupported(row[basisIndex], basis),
      )
    );
  } catch {
    return false;
  }
}
/** The complete source line prevents a model from hiding rent units outside a shorter quote. */
export function retainedQuoteContext(text: string, quote: string) {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const needle = normalize(quote);
  const lines = text.split(/\r?\n/).filter((line) => normalize(line).includes(needle));
  return lines.length ? lines.join("\n") : quote;
}
/** Labelled aircraft are separated by ---; include their own terms so omitted mode/units cannot change an amount's meaning. */
export function retainedCommercialContext(text: string, quote: string) {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const sections = text
    .split(/(?:^|\n)\s*---+\s*(?:\n|$)/)
    .filter((section) => normalize(section).includes(normalize(quote)));
  return sections.length === 1 ? sections[0] : retainedQuoteContext(text, quote);
}
export function purchaseAmountSupported(
  text: string,
  amount: number,
  options: { csv?: boolean; candidateText?: string } = {},
) {
  const clauses = text.split(/\r?\n|;|(?<=[.!?])\s+/);
  return clauses.some((clause) => {
    if (!amountSupported(clause, amount)) return false;
    if (!options.csv && !currencySupported(clause, "USD")) return false;
    // Explicit periodic units on this monetary statement always belong in leaseRate/leaseBudget.
    if (/\bmonth(?:ly)?\b|\bhour(?:ly)?\b|\/\s*(?:mo|mth|hr)\b/i.test(clause)) return false;
    if (hasLeaseLanguage(clause) && !hasExplicitPurchasePrice(clause)) return false;
    if (
      hasLeaseLanguage(options.candidateText ?? "") &&
      !hasExplicitPurchasePrice(clause) &&
      !hasSaleLanguage(options.candidateText ?? "")
    )
      return false;
    return true;
  });
}
