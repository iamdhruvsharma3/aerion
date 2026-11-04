/** Currency amounts cross the API as decimal strings, never binary floating point. */
export const currencyDigits = {
  USD: 2,
  INR: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  CHF: 2,
  CAD: 2,
  AUD: 2,
  SGD: 2,
  JPY: 0,
  KWD: 3,
} as const;
export type Currency = keyof typeof currencyDigits;
export const currencies = Object.keys(currencyDigits) as Currency[];
export const maxMinor = 9_999_999_999_999_999n;

export function moneyMinor(value: string, currency: Currency, allowZero = false): bigint {
  const digits = currencyDigits[currency];
  const match = /^(0|[1-9]\d{0,16})(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match || (match[2]?.length ?? 0) > digits)
    throw new Error(`Use a plain ${currency} amount with at most ${digits} decimal places.`);
  const minor =
    BigInt(match[1]) * 10n ** BigInt(digits) + BigInt((match[2] ?? "").padEnd(digits, "0") || "0");
  if (minor > maxMinor || (allowZero ? minor < 0n : minor <= 0n))
    throw new Error("The amount must be positive and within the supported bound.");
  return minor;
}
export function minorDecimal(value: string | bigint, currency: Currency): string {
  const amount = BigInt(value),
    digits = currencyDigits[currency];
  const sign = amount < 0n ? "-" : "",
    absolute = amount < 0n ? -amount : amount;
  if (!digits) return `${sign}${absolute}`;
  const factor = 10n ** BigInt(digits);
  return `${sign}${absolute / factor}.${String(absolute % factor).padStart(digits, "0")}`;
}
export function revenueMoney(value: string | bigint | null, currency: Currency): string {
  if (value === null) return "Not recorded";
  const [whole, fraction] = minorDecimal(value, currency).split(".");
  return `${currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction === undefined ? "" : `.${fraction}`}`;
}
export function percentageUnits(value: string): bigint {
  const match = /^(0|[1-9]\d{0,2})(?:\.(\d{1,4}))?$/.exec(value.trim());
  if (!match) throw new Error("Use a percentage with at most four decimal places.");
  const rate = BigInt(match[1]) * 10_000n + BigInt((match[2] ?? "").padEnd(4, "0"));
  if (rate <= 0n || rate > 1_000_000n)
    throw new Error("The fee percentage must be greater than zero and at most 100.");
  return rate;
}
export function percentageFee(basis: bigint, rate: string): bigint {
  if (basis <= 0n || basis > maxMinor)
    throw new Error("A supported positive calculation basis is required.");
  const fee = (basis * percentageUnits(rate) + 500_000n) / 1_000_000n;
  if (fee <= 0n || fee > maxMinor)
    throw new Error("The calculated fee is outside the supported currency bound.");
  return fee;
}
